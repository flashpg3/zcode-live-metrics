// Metric 口径 against synthetic samples with hand-checked numbers.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  tpsLast,
  genThroughput,
  intensity,
  cacheHit,
  contextTokens,
  contextPct,
  modelBreakdown,
  tokenTotals,
} from "../server/core/metrics.mjs";
import { parseSample } from "../server/adapt/rollout.mjs";
import { SessionStore, sessionView } from "../server/core/sessions.mjs";

const sample = (over = {}) => ({
  t: 1000, out: 100, in: 50, cacheR: 200, cacheC: 0, dur: 2000,
  model: "glm-4.6", provider: "p", attempt: 1, querySource: "main_turn",
  requestId: "r", sessionId: "sess_x", ...over,
});

test("单次实测速度 = output ÷ duration", () => {
  assert.equal(tpsLast(sample({ out: 300, dur: 1500 })), 200);
  assert.equal(tpsLast(sample({ dur: 0 })), null);
});

test("生成吞吐 = Σoutput ÷ Σduration（纯生成时间）", () => {
  const s = [sample({ out: 300, dur: 1000 }), sample({ out: 100, dur: 3000 })];
  assert.equal(genThroughput(s), 400 / 4);
  assert.equal(genThroughput([]), null);
});

test("会话强度分母是墙钟（含空闲）", () => {
  const now = 100_000;
  // 100 output tokens inside the 10s window → 100/10 = 10 t/s
  const s = [sample({ t: now - 30_000, out: 500 }), sample({ t: now - 5_000, out: 100 })];
  assert.equal(intensity(s, now, 10_000), 10);
  // same tokens over a 60s window → 100/60
  assert.equal(Math.round(intensity(s, now, 60_000) * 10) / 10, Math.round((600 / 60) * 10) / 10);
});

test("缓存命中率三态：正常 / 分母为 0 → null", () => {
  assert.equal(cacheHit(100, 200, 100), 0.5);
  assert.equal(cacheHit(0, 0, 0), null);
});

test("上下文水位与已知模型百分比", () => {
  const s = sample({ in: 1000, cacheR: 8000, cacheC: 1000 });
  assert.equal(contextTokens(s), 10_000);
  assert.equal(contextPct(100_000, "glm-4.6"), 0.5);
  assert.equal(contextPct(100_000, "unknown-model"), null);
});

test("模型拆分按输出降序并累计重试", () => {
  const s = [
    sample({ model: "a", out: 10, attempt: 2 }),
    sample({ model: "b", out: 99 }),
    sample({ model: "a", out: 20 }),
  ];
  const m = modelBreakdown(s);
  assert.equal(m[0].model, "b");
  assert.equal(m[1].model, "a");
  assert.equal(m[1].calls, 2);
  assert.equal(m[1].retries, 1);
});

test("parseSample 走真实 rollout 行结构（usage 直取 + querySource）", () => {
  const line = JSON.stringify({
    type: "model_io", completedAt: "2026-10-02T08:08:40.000Z", startedAt: "2026-10-02T08:08:30.000Z",
    durationMs: 9987, attempt: 1, querySource: "subagent", requestId: "r1", sessionId: "sess_x",
    model: { modelId: "GLM-5.3-Flash", providerId: "account:x" },
    response: { usage: { input_tokens: 584, output_tokens: 7180, cache_read_input_tokens: 83584 } },
  });
  const s = parseSample(line);
  assert.equal(s.out, 7180);
  assert.equal(s.querySource, "subagent");
  assert.equal(s.model, "GLM-5.3-Flash");
  assert.equal(s.cacheR, 83584);
  assert.equal(s.cacheC, 0);
});

test("parseSample 回退到 providerMetadata.anthropic.usage", () => {
  const line = JSON.stringify({
    type: "model_io", completedAt: "2026-10-02T08:08:40.000Z",
    response: { providerMetadata: { anthropic: { usage: { input_tokens: 10, output_tokens: 5 } } } },
  });
  const s = parseSample(line);
  assert.equal(s.out, 5);
  assert.equal(s.cacheC, 0);
});

test("parseSample 拒绝非 model_io 与缺 token 的行", () => {
  assert.equal(parseSample('{"type":"other"}'), null);
  assert.equal(parseSample('{"type":"model_io","response":{"usage":{"input_tokens":1}}}'), null);
  assert.equal(parseSample("not json"), null);
});

test("会话存储：批量截断、生成中由样本落盘清除", () => {
  const store = new SessionStore(100);
  for (let i = 0; i < 620; i++) store.ingest("sess_x", sample({ t: i, requestId: "r" + i }));
  const s = store.sessions.get("sess_x");
  assert.ok(s.samples.length >= 100 && s.samples.length <= 600, `sawtooth within [max, max+500]: ${s.samples.length}`);
  assert.equal(s.samples.at(-1).t, 619);

  store.setGenerating("sess_x", "traceA", 5000);
  assert.ok(store.sessions.get("sess_x").gen);
  store.ingest("sess_x", sample({ t: 6000, requestId: "r2" }));
  assert.equal(store.sessions.get("sess_x").gen, null);
});

test("sessionView 汇总口径齐全", () => {
  const store = new SessionStore();
  store.ingest("sess_x", sample());
  const v = sessionView(store.get("sess_x"), 1000);
  assert.equal(v.tokens.calls, 1);
  assert.equal(v.cache.all, cacheHit(50, 200, 0));
  assert.equal(v.models[0].model, "glm-4.6");
  assert.equal(v.context.tokens, 250);
  assert.ok(v.genThroughput > 0);
});

test("tokenTotals 计数重试", () => {
  const t = tokenTotals([sample(), sample({ attempt: 3 })]);
  assert.equal(t.calls, 2);
  assert.equal(t.retries, 1);
});
