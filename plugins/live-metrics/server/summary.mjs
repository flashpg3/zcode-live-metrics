// Human-readable one-page summary shared by metrics_summary (MCP) and the
// /metrics slash command. Pure function of a snapshot — trivially testable.
const pct = (v) => (v == null ? "—" : `${Math.round(v * 100)}%`);
const tps = (v) => (v == null ? "—" : `${v.toFixed(1)} t/s`);
const ago = (ts, now) => {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  return s < 60 ? `${s}s 前` : `${Math.round(s / 60)}m 前`;
};
const tok = (n) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

export function renderSummaryText(snap) {
  if (!snap || !snap.focus) {
    return "live-metrics: 暂无会话数据（监控引擎已启动，等待首次模型调用落盘）。";
  }
  const f = snap.focus;
  const gen = f.generating
    ? `⚡ 生成中（已 ${Math.max(0, Math.round((snap.now - f.generating.since) / 1000))}s）`
    : "空闲";
  const lines = [];
  lines.push(`live-metrics v${snap.v} · ${f.title || f.id}`);
  lines.push(`状态: ${gen} · 最近活动 ${ago(f.lastActivity, snap.now)}`);
  lines.push(
    `速度: 单次 ${tps(f.last?.tps)} · 生成吞吐 ${tps(f.genThroughput)} · 会话强度 ${tps(f.intensity?.s10)}/10s`,
  );
  lines.push(
    `缓存命中率: 累计 ${pct(f.cache?.all)} · 60s ${pct(f.cache?.s60)} · 最近一次 ${pct(f.cache?.last)}`,
  );
  const t = f.tokens;
  if (t) {
    lines.push(
      `累计 token: 输入 ${tok(t.in)} · 缓存读 ${tok(t.cacheR)} · 缓存写 ${tok(t.cacheC)} · 输出 ${tok(t.out)} · 调用 ${t.calls} 次${t.retries ? ` · 重试 ${t.retries}` : ""}`,
    );
  }
  const ctx = f.context;
  if (ctx) {
    lines.push(
      `上下文水位: ${tok(ctx.tokens)} tokens${ctx.pct != null ? `（${Math.round(ctx.pct * 100)}% / ${tok(ctx.pct ? ctx.tokens / ctx.pct : 0)}）` : ""}`,
    );
  }
  if (f.models?.length) {
    lines.push("模型拆分:");
    for (const m of f.models.slice(0, 4)) {
      lines.push(`  ${m.model}: ${m.calls} 次 · 输出 ${tok(m.out)} · 平均 ${tps(m.tps)}${m.retries ? ` · 重试 ${m.retries}` : ""}`);
    }
  }
  const recent = (f.recent || []).slice(0, 5);
  if (recent.length) {
    lines.push("最近调用:");
    for (const c of recent) {
      lines.push(
        `  ${ago(c.t, snap.now)} · ${c.model} · 输出 ${tok(c.out)} · ${tps(c.tps)} · ${(c.dur / 1000).toFixed(1)}s${c.attempt > 1 ? ` · attempt ${c.attempt}` : ""}`,
      );
    }
  }
  const others = (snap.sessions || []).filter((s) => s.id !== f.id);
  if (others.length) {
    lines.push(`其他会话 ${others.length} 个: ${others.slice(0, 3).map((s) => (s.title || s.id.slice(5, 13)) + (s.generating ? " ⚡" : "")).join(" · ")}`);
  }
  return lines.join("\n");
}
