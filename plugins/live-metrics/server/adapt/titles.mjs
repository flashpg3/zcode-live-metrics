// Session titles from the host SQLite db (optional nicety for the session
// switcher). Read-only sqlite3 CLI; any failure degrades silently to ids.
import { execFile } from "node:child_process";
import { SEEN_RE } from "./hostlog.mjs";

export function fetchTitles(dbPath, sessionIds, timeoutMs = 3000) {
  const ids = sessionIds.filter((id) => SEEN_RE.test(id)).slice(0, 16);
  if (!ids.length) return Promise.resolve({});
  const list = ids.map((id) => `'${id}'`).join(",");
  const sql = `SELECT id,title FROM session WHERE id IN (${list})`;
  return new Promise((resolve) => {
    execFile(
      "/usr/bin/sqlite3",
      ["-readonly", "-json", dbPath, sql],
      { timeout: timeoutMs },
      (err, stdout) => {
        if (err) return resolve({});
        try {
          const rows = JSON.parse(stdout || "[]");
          const out = {};
          for (const r of rows) if (r.id && r.title) out[r.id] = String(r.title);
          resolve(out);
        } catch {
          resolve({});
        }
      },
    );
  });
}
