// Loopback HTTP server: dashboard page, static assets, snapshot API and
// push-on-change SSE. Binds 127.0.0.1 only; probes portBase..+portProbe.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { URL } from "node:url";
import { config } from "./config.mjs";

const UI_DIR = path.join(path.dirname(new URL(import.meta.url).pathname), "ui");
const MIME = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml" };

export class HttpService {
  sseClients = new Set();
  lastPush = "";

  constructor(handlers) {
    this.handlers = handlers; // { snapshot(), history(), pin(id), unpin(), open() }
    this.server = http.createServer((req, res) => this.#route(req, res));
    this.server.on("error", () => {}); // probe: EADDRINUSE handled by caller
  }

  listen() {
    return new Promise((resolve, reject) => {
      const tryPort = (port) => {
        if (port > config.portBase + config.portProbe) {
          return reject(new Error("no free port"));
        }
        const onErr = () => {
          this.server.close();
          this.server.removeAllListeners("listening");
          tryPort(port + 1);
        };
        this.server.once("error", onErr);
        this.server.listen(port, "127.0.0.1", () => {
          this.server.removeAllListeners("error");
          this.port = port;
          resolve(port);
        });
      };
      tryPort(config.portBase);
    });
  }

  get url() {
    return `http://127.0.0.1:${this.port}/`;
  }

  // Push snapshot to every SSE client when its JSON changed.
  broadcast(snapshot) {
    const json = JSON.stringify(snapshot);
    if (json === this.lastPush) return false;
    this.lastPush = json;
    const frame = `data: ${json}\n\n`;
    for (const res of this.sseClients) res.write(frame);
    return true;
  }

  ping() {
    for (const res of this.sseClients) res.write(": ping\n\n");
  }

  #route(req, res) {
    const u = new URL(req.url, "http://x");
    const p = u.pathname;
    if (p === "/api/stream") return this.#sse(res);
    if (p === "/api/snapshot") return this.#json(res, this.handlers.snapshot());
    if (p === "/api/history") return this.#json(res, this.handlers.history());
    if (p === "/api/session" && req.method === "POST") {
      let body = "";
      req.on("data", (c) => (body += c));
      return req.on("end", () => {
        try {
          const { op, id } = JSON.parse(body || "{}");
          if (op === "pin") this.handlers.pin(String(id || ""));
          else if (op === "unpin") this.handlers.unpin();
        } catch {}
        this.#json(res, { ok: true });
      });
    }
    if (p === "/api/open" && req.method === "POST") {
      this.handlers.open();
      return this.#json(res, { ok: true, url: this.url });
    }
    if (p === "/" || p === "/index.html") return this.#static(res, "index.html");
    if (p.startsWith("/static/")) {
      const name = path.basename(p.slice("/static/".length));
      return this.#static(res, name);
    }
    res.writeHead(404).end();
  }

  #sse(res) {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      connection: "keep-alive",
    });
    res.write(`retry: 1000\n\n`);
    res.write(`data: ${this.lastPush || JSON.stringify(this.handlers.snapshot())}\n\n`);
    this.sseClients.add(res);
    res.on("close", () => this.sseClients.delete(res));
  }

  #json(res, obj) {
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(obj));
  }

  #static(res, name) {
    const file = path.join(UI_DIR, name);
    try {
      const data = fs.readFileSync(file);
      res.writeHead(200, { "content-type": MIME[path.extname(name)] || "application/octet-stream", "cache-control": "no-store" });
      res.end(data);
    } catch {
      res.writeHead(404).end();
    }
  }
}
