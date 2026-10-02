// Dashboard front-end: consumes SSE push-on-change snapshots, renders cards,
// intensity ring chart, model breakdown, recent calls, history tab.
// Local 1s tick keeps mid-generation elapsed timers alive between pushes.
"use strict";

const $ = (id) => document.getElementById(id);
const fmtTps = (v) => (v == null ? "—" : v.toFixed(1));
const pct = (v) => (v == null ? "—" : `${Math.round(v * 100)}%`);
const tok = (n) =>
  n == null ? "—" : n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1000 ? (n / 1000).toFixed(1) + "k" : String(n);
const ago = (ts, now) => {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  return s < 60 ? `${s}s 前` : s < 3600 ? `${Math.round(s / 60)}m 前` : `${Math.round(s / 3600)}h 前`;
};
const clock = (ts) => new Date(ts).toTimeString().slice(0, 8);

let snap = null;
let frozen = false;
let lastRendered = 0;

function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(t._h);
  t._h = setTimeout(() => (t.hidden = true), 1200);
}

async function post(path, body) {
  try {
    const r = await fetch(path, { method: "POST", body: JSON.stringify(body || {}) });
    return await r.json();
  } catch {
    return null;
  }
}

function copyText(v) {
  if (v == null || v === "—") return;
  navigator.clipboard?.writeText(String(v)).then(() => toast(`已复制 ${v}`), () => {});
}

// ---- rendering ------------------------------------------------------------
function render() {
  if (!snap || frozen) return;
  lastRendered = snap.now;
  $("ver").textContent = "v" + snap.v;
  const f = snap.focus;

  // status line + header dot
  const dot = $("dot");
  const gs = $("genstate");
  if (f?.generating) {
    dot.className = "dot gen";
    gs.className = "";
    gs.textContent = `⚡ 生成中 ${Math.max(0, Math.round((snap.now - f.generating.since) / 1000))}s`;
  } else {
    dot.className = "dot idle";
    gs.className = "idle";
    gs.textContent = f ? "空闲" : "等待数据";
  }
  $("lastact").textContent = f ? `焦点: ${f.title || f.id.slice(5, 17)} · 最近活动 ${ago(f.lastActivity, snap.now)}` : "";

  // cards
  $("m-last").textContent = f?.last ? fmtTps(f.last.tps) : "—";
  $("m-last-sub").textContent = f?.last
    ? `上次调用 ${clock(f.last.t)} · ${f.last.model}` + (f.generating ? "（生成中显示上次）" : "")
    : "";
  if (f?.generating) $("m-last-sub").textContent += "";
  $("m-gen").textContent = fmtTps(f?.genThroughput);
  $("m-int").textContent = fmtTps(f?.intensity?.s10);
  $("m-cache").textContent = pct(f?.cache?.all);
  $("c-all").textContent = pct(f?.cache?.all);
  $("c-60").textContent = pct(f?.cache?.s60);
  $("c-last").textContent = pct(f?.cache?.last);
  const ctx = f?.context;
  $("m-ctx").textContent = ctx ? tok(ctx.tokens) : "—";
  $("m-ctx-sub").textContent = ctx
    ? ctx.pct != null
      ? `${Math.round(ctx.pct * 100)}% of ctx · ${ctx.model}`
      : ctx.model
    : "";
  $("m-ctx-bar").style.width = ctx?.pct != null ? `${Math.min(100, ctx.pct * 100)}%` : "0%";

  // chart: intensity ring, honest zeros when idle
  drawChart(snap.ring?.points || []);

  // models
  const models = f?.models || [];
  const maxOut = Math.max(1, ...models.map((m) => m.out));
  $("models-panel").hidden = models.length === 0;
  $("models").innerHTML = models
    .map(
      (m) => `<div class="model-row">
        <span class="model-name" title="${esc(m.model)}">${esc(m.model)}</span>
        <span class="model-bar-wrap"><span class="model-bar" style="width:${(m.out / maxOut) * 100}%"></span></span>
        <span class="model-meta">${m.calls} 次 · ${tok(m.out)} out · ${fmtTps(m.tps)} t/s
          ${m.retries ? `<span class="retry-badge">retry×${m.retries}</span>` : ""}</span>
      </div>`,
    )
    .join("");

  // recent calls
  $("calls").innerHTML = (f?.recent || [])
    .map(
      (c) => `<tr>
        <td>${clock(c.t)}</td>
        <td title="${esc(c.src)}">${esc(c.model)}${c.attempt > 1 ? ` <span class="retry-badge">×${c.attempt}</span>` : ""}</td>
        <td class="num" data-v="${c.in}">${tok(c.in)}</td>
        <td class="num" data-v="${c.cacheR + c.cacheC}">${tok(c.cacheR + c.cacheC)}</td>
        <td class="num" data-v="${c.out}">${tok(c.out)}</td>
        <td class="num" data-v="${c.tps ?? ""}">${fmtTps(c.tps)}</td>
        <td>${(c.dur / 1000).toFixed(1)}s</td>
      </tr>`,
    )
    .join("");

  // session switcher + pin state
  const sel = $("session");
  const opts = (snap.sessions || [])
    .map(
      (s) =>
        `<option value="${s.id}" ${snap.focus && s.id === snap.focus.id ? "selected" : ""}>${esc(s.title || s.id.slice(5, 17))}${s.generating ? " ⚡" : ""}</option>`,
    )
    .join("");
  if (sel.innerHTML !== opts) sel.innerHTML = opts;
  $("pin").classList.toggle("on", !!snap.pinned);
}

function drawChart(points) {
  const svg = $("chart");
  const W = 600, H = 120;
  if (!points.length) {
    svg.innerHTML = `<line x1="0" y1="${H - 1}" x2="${W}" y2="${H - 1}" stroke="#1f2733"/>`;
    return;
  }
  const max = Math.max(1, ...points.map((p) => p.v));
  const step = W / Math.max(1, points.length - 1);
  const xy = points.map((p, i) => `${(i * step).toFixed(1)},${(H - 6 - (p.v / max) * (H - 16)).toFixed(1)}`);
  svg.innerHTML =
    `<polygon fill="rgba(88,166,255,.14)" points="0,${H} ${xy.join(" ")} ${W},${H}"/>` +
    `<polyline fill="none" stroke="#58a6ff" stroke-width="1.5" points="${xy.join(" ")}"/>`;
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---- history view ---------------------------------------------------------
let histTimer = null;
async function loadHistory() {
  try {
    const h = await (await fetch("/api/history")).json();
    $("hist-meta").textContent = h.files ? `${h.files} 个 rollout 文件` : "";
    $("hist-days").innerHTML = (h.days || [])
      .slice(0, 14)
      .map(
        (d) => `<tr>
          <td>${d.day}</td><td>${d.calls}</td>
          <td class="num">${tok(d.in)}</td><td class="num">${tok(d.cacheR)}</td><td class="num">${tok(d.out)}</td>
          <td class="dim">${esc((d.topModels || []).map((m) => m.model).join(", "))}</td>
        </tr>`,
      )
      .join("");
    $("hist-sessions").innerHTML = (h.sessions || [])
      .slice(0, 20)
      .map(
        (s) => `<tr>
          <td title="${s.id}">${esc(s.id.slice(5, 21))}…</td>
          <td>${ago(s.last, Date.now())}</td><td>${s.calls}</td><td class="num">${tok(s.out)}</td>
          <td class="dim">${esc((s.topModels || []).map((m) => m.model).join(", "))}</td>
        </tr>`,
      )
      .join("");
  } catch {}
}

// ---- wiring ---------------------------------------------------------------
new EventSource("/api/stream").onmessage = (e) => {
  try {
    snap = JSON.parse(e.data);
    render();
  } catch {}
};

setInterval(() => {
  // keep the generating timer ticking between pushes (PRD A2: alive every second)
  if (snap?.focus?.generating) {
    render();
  }
}, 1000);

$("session").addEventListener("change", (e) => post("/api/session", { op: "pin", id: e.target.value }));
$("pin").addEventListener("click", async () => {
  const r = await post("/api/session", { op: snap?.pinned ? "unpin" : "pin", id: snap?.focus?.id });
  if (r?.ok) toast(snap?.pinned ? "已解锁，恢复自动跟随" : "已钉住当前会话");
});
$("freeze").addEventListener("click", () => {
  frozen = !frozen;
  $("freeze").classList.toggle("on", frozen);
  $("freeze").textContent = frozen ? "▶" : "⏸";
  toast(frozen ? "画面已冻结（数据继续接收）" : "已恢复实时");
  if (!frozen) render();
});
$("open").addEventListener("click", () => post("/api/open"));
$("tab-history").addEventListener("click", (e) => {
  const showHist = $("view-history").hidden;
  $("view-history").hidden = !showHist;
  $("view-live").hidden = showHist;
  e.target.classList.toggle("on", showHist);
  if (showHist) {
    loadHistory();
    clearInterval(histTimer);
    histTimer = setInterval(loadHistory, 5000);
  } else clearInterval(histTimer);
});

document.addEventListener("click", (e) => {
  const el = e.target.closest("[data-copy],[data-v]");
  if (el) copyText(el.dataset.v ?? el.textContent.trim());
});
