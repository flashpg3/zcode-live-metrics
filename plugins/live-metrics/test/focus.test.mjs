// Focus state machine (PRD §4.4): follow the most recently active session,
// debounce switches, pin overrides everything.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Focus } from "../server/core/focus.mjs";

const acts = (pairs) => new Map(pairs);

test("初始跟随最近活跃会话", () => {
  const f = new Focus();
  assert.equal(f.update(acts([["sess_a", 100], ["sess_b", 200]])), "sess_b");
});

test("切换需要连续 2 个周期一致（防抖）", () => {
  const f = new Focus();
  f.update(acts([["sess_a", 100]]));
  assert.equal(f.current, "sess_a");
  f.update(acts([["sess_b", 300]]));
  assert.equal(f.current, "sess_a"); // streak 1, not yet
  f.update(acts([["sess_b", 400]]));
  assert.equal(f.current, "sess_b"); // streak 2 → switch
});

test("单次闪烁不切换", () => {
  const f = new Focus();
  f.update(acts([["sess_a", 100]]));
  f.update(acts([["sess_b", 200]]));
  f.update(acts([["sess_a", 300]])); // b flickered once, a still hottest
  f.update(acts([["sess_a", 400]]));
  assert.equal(f.current, "sess_a");
});

test("钉住优先，解锁后恢复跟随", () => {
  const f = new Focus();
  f.update(acts([["sess_a", 100]]));
  f.pin("sess_b");
  assert.equal(f.update(acts([["sess_a", 999]])), "sess_b");
  f.unpin();
  assert.equal(f.update(acts([["sess_a", 1000]])), "sess_a");
});
