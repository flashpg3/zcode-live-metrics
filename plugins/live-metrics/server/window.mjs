// Floating-window orchestration: spawn the native macOS window
// (WKWebView via swift) or the Linux browser app-mode fallback, re-adopt a
// surviving window, and auto-reopen a lost one within the 30s budget.
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import { config, FILES, statePath, writeStateJson, floatingWindowMode } from "./config.mjs";

// raw-pid files (daemon.pid, floating-window.pid) are plain text: both the
// writer and every reader (shell hooks included) agree on `cat file` semantics.
const writeRawState = (name, text) => {
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.writeFileSync(statePath(name), text);
};

const LINUX_BROWSERS = [
  "chromium", "chromium-browser", "google-chrome", "google-chrome-stable",
  "microsoft-edge", "brave-browser", "/usr/bin/chromium", "/usr/bin/google-chrome",
];

function pidAlive(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function windowProcessAlive() {
  try {
    const pid = Number(fs.readFileSync(statePath(FILES.floatingWindowPid), "utf8").trim());
    return pidAlive(pid) && alivePidIsOurs(pid);
  } catch {
    return false;
  }
}

// Guard against PID reuse: the owner must be a live-metrics window process.
function alivePidIsOurs(pid) {
  try {
    const cmd = execFileSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" });
    return /window\.swift|--app=.*127\.0\.0\.1/.test(cmd);
  } catch {
    return false;
  }
}

function findLinuxBrowser() {
  for (const b of LINUX_BROWSERS) {
    try {
      execFileSync("which", [b], { stdio: "ignore" });
      return b;
    } catch {}
  }
  return null;
}

export class WindowManager {
  constructor() {
    this.swiftUsable = null; // lazily probed once
  }

  get mode() {
    return floatingWindowMode();
  }

  get wanted() {
    return this.mode !== "off";
  }

  isAlive() {
    return windowProcessAlive();
  }

  // Reopen if missing. Called every ~10s; meets the ≤30s reopen budget.
  ensure(dashboardUrl) {
    if (!this.wanted || !dashboardUrl) return false;
    if (windowProcessAlive()) return false;
    return this.spawn(dashboardUrl);
  }

  spawn(dashboardUrl) {
    const mode = this.mode;
    try {
      if (process.platform === "darwin") {
        if (this.swiftUsable === null) {
          try {
            execFileSync(config.swiftPath, ["--version"], { stdio: "ignore", timeout: 8000 });
            this.swiftUsable = true;
          } catch {
            this.swiftUsable = false;
          }
        }
        if (this.swiftUsable) {
          const child = spawn(
            config.swiftPath,
            [`${config.pluginRoot}/scripts/window.swift`, dashboardUrl, statePath(FILES.dashboard)],
            { detached: true, stdio: "ignore" },
          );
          child.unref();
          writeRawState(FILES.floatingWindowPid, String(child.pid));
          return true;
        }
      }
      if (mode !== "auto" && mode !== "browser") return false;
      const browser = findLinuxBrowser();
      if (browser && process.platform !== "darwin") {
        const child = spawn(browser, ["--app=" + dashboardUrl, "--window-size=380,660"], {
          detached: true,
          stdio: "ignore",
        });
        child.unref();
        writeRawState(FILES.floatingWindowPid, String(child.pid));
        return true;
      }
    } catch {}
    return false;
  }
}
