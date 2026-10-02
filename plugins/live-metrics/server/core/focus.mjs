// Focus state machine (PRD §4.4): auto-follow the most recently active
// session; a manual pin overrides until unpinned; switches are debounced
// (candidate must win 2 consecutive update cycles).
export class Focus {
  pinned = null;
  current = null;
  #candidate = null;
  #streak = 0;
  #forceSwitch = false;

  // activities: Map<sessionId, lastActivityTs> (hook signal already merged in)
  update(activities) {
    if (this.pinned) {
      this.current = this.pinned;
      return this.current;
    }
    let best = null;
    let bestTs = -1;
    for (const [id, ts] of activities) {
      if (ts > bestTs) {
        bestTs = ts;
        best = id;
      }
    }
    if (!best) return this.current;
    if (this.current == null || best === this.current) {
      this.current = best;
      this.#candidate = null;
      this.#streak = 0;
      this.#forceSwitch = false;
      return this.current;
    }
    if (this.#forceSwitch) {
      // right after an explicit unpin, following resumes immediately
      this.current = best;
      this.#forceSwitch = false;
      this.#candidate = null;
      this.#streak = 0;
      return this.current;
    }
    if (best === this.#candidate) {
      this.#streak++;
    } else {
      this.#candidate = best;
      this.#streak = 1;
    }
    if (this.#streak >= 2) {
      this.current = best;
      this.#candidate = null;
      this.#streak = 0;
    }
    return this.current;
  }

  pin(sessionId) {
    this.pinned = sessionId;
    this.current = sessionId;
  }

  unpin() {
    this.pinned = null;
    this.#forceSwitch = true; // following resumes on the next update
  }
}
