// Framing contract: strict newline framing must never split or glue lines,
// survive UTF-8 boundaries, rotations, and pathologically long lines.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTail, pollLines } from "../server/adapt/tail.mjs";

function tmpfile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "lm-tail-")), "f.jsonl");
}

test("complete lines arrive exactly once, in order", () => {
  const f = tmpfile();
  fs.writeFileSync(f, '{"a":1}\n{"b":2}\n');
  const tail = createTail(f);
  assert.deepEqual(pollLines(f, tail).map((l) => JSON.parse(l).a ?? JSON.parse(l).b), [1, 2]);
  assert.deepEqual(pollLines(f, tail), []); // no re-emission
  fs.appendFileSync(f, '{"c":3}\n');
  assert.deepEqual(pollLines(f, tail).map((l) => JSON.parse(l).c), [3]);
});

test("half line is held back until its newline arrives", () => {
  const f = tmpfile();
  const tail = createTail(f);
  fs.writeFileSync(f, '{"a":1}\n{"b"');
  assert.deepEqual(pollLines(f, tail).length, 1);
  fs.appendFileSync(f, ':2}\n{"c":3}\n');
  const lines = pollLines(f, tail);
  assert.deepEqual(lines.map((l) => JSON.parse(l).b ?? JSON.parse(l).c), [2, 3]);
});

test("a full JSON line ending in whitespace is NOT mistaken for a half line", () => {
  const f = tmpfile();
  fs.writeFileSync(f, '{"a":1}  \n{"b":2} \r\n');
  const tail = createTail(f);
  const lines = pollLines(f, tail);
  assert.equal(lines.length, 2);
  assert.equal(JSON.parse(lines[0]).a, 1);
  assert.equal(JSON.parse(lines[1]).b, 2);
});

test("multibyte UTF-8 split across reads survives", () => {
  const f = tmpfile();
  const tail = createTail(f);
  const line = '{"s":"你 好 🌊"}\n';
  const buf = Buffer.from(line);
  fs.writeFileSync(f, buf.subarray(0, 18)); // cuts inside the emoji
  pollLines(f, tail);
  fs.appendFileSync(f, buf.subarray(18));
  const lines = pollLines(f, tail);
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0]).s, "你 好 🌊");
});

test("file rotation/truncation restarts from zero", () => {
  const f = tmpfile();
  fs.writeFileSync(f, '{"a":1}\n{"b":2}\n{"c":3}\n');
  const tail = createTail(f);
  pollLines(f, tail);
  fs.writeFileSync(f, '{"fresh":true}\n'); // truncated
  const lines = pollLines(f, tail);
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0]).fresh, true);
});

test("oversized newline-less garbage is dropped, counting a skip", () => {
  const f = tmpfile();
  fs.writeFileSync(f, "x".repeat(2 << 20) + "\n{\"ok\":1}\n");
  const tail = createTail(f);
  const all = [];
  for (let i = 0; i < 12; i++) all.push(...pollLines(f, tail, 262_144));
  assert.equal(tail.skipped, 1); // the garbage line dropped, counted once
  assert.deepEqual(all.map((l) => JSON.parse(l).ok), [1]); // next line survives intact
});
