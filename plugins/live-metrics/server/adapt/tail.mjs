// Byte-offset incremental tail reader with strict newline framing.
// A partial trailing line is kept in `carry` (via StringDecoder, so UTF-8
// sequences split across reads survive) and only emitted once its \n arrives.
// This replaces the old `!line.endsWith("}")` heuristic that polluted samples.
import fs from "node:fs";
import { StringDecoder } from "node:string_decoder";

const MAX_CARRY = 1 << 20; // drop pathologically long lines instead of growing forever

export function createTail(file = "") {
  return { file, offset: 0, carry: "", decoder: new StringDecoder("utf8"), skipped: 0, skipping: false };
}

// Returns complete lines appended since the last call. Mutates `tail`.
export function pollLines(file, tail, maxBytes = 262_144) {
  if (tail.file !== file) {
    tail.file = file;
    tail.offset = 0;
    tail.carry = "";
    tail.skipping = false;
    tail.decoder = new StringDecoder("utf8");
  }
  let st;
  try {
    st = fs.statSync(file);
  } catch {
    return [];
  }
  if (st.size < tail.offset) {
    // rotated or truncated: start over
    tail.offset = 0;
    tail.carry = "";
    tail.skipping = false;
    tail.decoder = new StringDecoder("utf8");
  }
  if (st.size === tail.offset) return [];
  const len = Math.min(st.size - tail.offset, maxBytes);
  const buf = Buffer.alloc(len);
  const fd = fs.openSync(file, "r");
  try {
    fs.readSync(fd, buf, 0, len, tail.offset);
  } finally {
    fs.closeSync(fd);
  }
  tail.offset += len;
  let text = (tail.skipping ? "" : tail.carry) + tail.decoder.write(buf);

  if (tail.skipping) {
    // inside an oversized dropped line: discard until its newline arrives
    const nl = text.indexOf("\n");
    if (nl === -1) return [];
    tail.skipping = false;
    text = text.slice(nl + 1);
  }

  const nl = text.lastIndexOf("\n");
  if (nl === -1) {
    if (text.length > MAX_CARRY) {
      tail.skipping = true; // drop the oversized line, skip to its end
      tail.skipped++;
      tail.carry = "";
    } else {
      tail.carry = text;
    }
    return [];
  }
  if (text.length - nl - 1 > MAX_CARRY) {
    tail.skipping = true;
    tail.skipped++;
    tail.carry = "";
  } else {
    tail.carry = text.slice(nl + 1);
  }
  return text.slice(0, nl).split("\n").filter(Boolean);
}
