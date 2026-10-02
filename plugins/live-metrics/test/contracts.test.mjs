// File contracts: manifests, version single-source, hook plumbing,
// window script presence, UI assets — the glue a refactor must not silently break.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const json = (p) => JSON.parse(read(p));

test("版本单一来源：plugin.json 与两个 marketplace.json 一致", () => {
  const v = json(".zcode-plugin/plugin.json").version;
  assert.equal(json("../../marketplace.json").plugins[0].version, v);
  assert.equal(json("../marketplace.json").plugins[0].version, v);
});

test("hooks 契约：三个事件 → bash 脚本，含 PLUGIN_ROOT 模板", () => {
  const h = json("hooks/hooks.json").hooks;
  for (const ev of ["SessionStart", "UserPromptSubmit", "Stop"]) {
    assert.ok(h[ev], `missing hook event ${ev}`);
    const cmd = h[ev][0].hooks[0].command;
    assert.match(cmd, /^\/bin\/bash/);
    assert.match(cmd, /\$\{CLAUDE_PLUGIN_ROOT\}\/hooks\/notify-session\.sh/);
  }
});

test("mcp 契约：bash 启动 + PLUGIN_DATA + user_config 模板", () => {
  const srv = json(".mcp.json").mcpServers["live-metrics"];
  assert.equal(srv.command, "/bin/bash");
  assert.match(srv.args[0], /\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/launch\.sh/);
  assert.equal(srv.env.ZCODE_METRICS_PLUGIN_DATA, "${CLAUDE_PLUGIN_DATA}");
  assert.equal(srv.env.ZCODE_METRICS_FLOATING, "${user_config.floating_window}");
});

test("launch.sh 可执行且声明 bash", () => {
  const st = fs.statSync(path.join(ROOT, "scripts/launch.sh"));
  assert.ok(st.mode & 0o111, "launch.sh must be executable");
  assert.match(read("scripts/launch.sh"), /^#!\/bin\/bash/);
  assert.match(read("hooks/notify-session.sh"), /^#!\/bin\/bash/);
});

test("悬浮窗脚本与 UI 资源存在", () => {
  for (const p of ["scripts/window.swift", "server/ui/index.html", "server/ui/app.css", "server/ui/app.js", "commands/metrics.md"]) {
    assert.ok(fs.existsSync(path.join(ROOT, p)), `missing ${p}`);
  }
});

test("commands/metrics.md 引用三个 MCP 工具名", () => {
  const md = read("commands/metrics.md");
  for (const tool of ["metrics_summary", "metrics_snapshot", "open_dashboard"]) {
    assert.ok(md.includes(tool), `missing tool ${tool}`);
  }
});

test("零依赖：不存在 node_modules 与 lockfile", () => {
  assert.ok(!fs.existsSync(path.join(ROOT, "node_modules")));
  assert.ok(!fs.existsSync(path.join(ROOT, "../../node_modules")));
  assert.ok(!fs.existsSync(path.join(ROOT, "../../package-lock.json")));
});
