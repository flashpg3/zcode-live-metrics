// Summary text rendering: every number shown must come from the snapshot.
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderSummaryText } from "../server/summary.mjs";
import { parseSample } from "../server/adapt/rollout.mjs";
import { SessionStore, sessionView } from "../server/core/sessions.mjs";

const LINE = JSON.stringify({
  type: "model_io", completedAt: "2026-10-02T08:08:40.000Z", startedAt: "2026-10-02T08:08:30.000Z",
  durationMs: 9987, attempt: 2, querySource: "main_turn", requestId: "r1", sessionId: "sess_x",
  model: { modelId: "GLM-5.3-Flash", providerId: "account:x" },
  response: { usage: { input_tokens: 584, output_tokens: 7180, cache_read_input_tokens: 83584 } },
});

test("summary 包含状态/速度/缓存/累计/重试，且数字可溯源", () => {
  const store = new SessionStore();
  store.ingest("sess_x", parseSample(LINE));
  const snap = {
    v: "1.0.0", now: Date.parse("2026-10-02T08:09:00.000Z"),
    focus: sessionView(store.get("sess_x"), Date.parse("2026-10-02T08:09:00.000Z")),
    sessions: [{ id: "sess_y", title: "另一个", generating: true, lastActivity: 1, out: 1, calls: 1 }],
  };
  const text = renderSummaryText(snap);
  assert.match(text, /空闲/);
  assert.match(text, /GLM-5\.3-Flash/);
  assert.match(text, /重试 1/); // attempt 2 counted
  assert.match(text, /7\.2k/); // output tokens
  assert.match(text, /另一个 ⚡/);
});

test("空快照有友好降级文案", () => {
  assert.match(renderSummaryText({ focus: null }), /暂无会话数据/);
});
