/* Pure decisions for cue preparation and playback. */
(function (root) {
  function cueAt(cues, time) {
    const found = cues.findIndex((cue) => cue.end >= time);
    return found < 0 ? cues.length : found;
  }

  function nextPending(cues, nextIndex) {
    let index = cues.findIndex((cue, at) => at >= nextIndex
      && !cue.buffer && !cue.failed && !cue.requested);
    if (index >= 0) return index;
    for (index = nextIndex - 1; index >= 0; index--) {
      const cue = cues[index];
      if (!cue.buffer && !cue.failed && !cue.requested) return index;
    }
    return -1;
  }

  function startup(cues, nextIndex, startTime) {
    let next = nextIndex;
    while (next < cues.length && (cues[next].buffer || cues[next].failed)) next++;
    const prepared = next - nextIndex;
    const readyUntil = cues[next - 1]?.end || startTime;
    return {
      prepared,
      ready: next >= cues.length || prepared >= 4 || readyUntil - startTime >= 20,
    };
  }

  function decide(cues, nextIndex, time, activeEnd) {
    if (activeEnd != null) {
      return { action: time >= activeEnd - 0.05 ? "pause-voice" : "none", nextIndex };
    }
    while (nextIndex < cues.length && cues[nextIndex].end < time - 0.3) nextIndex++;
    const cue = cues[nextIndex];
    if (!cue || time < cue.start - 0.05) return { action: "none", nextIndex };
    if (cue.failed) return { action: "skip", nextIndex: nextIndex + 1 };
    if (!cue.buffer) return { action: "pause-cue", nextIndex };
    return { action: "play", nextIndex: nextIndex + 1, cue };
  }

  // Audio recognition works in fixed windows. The window under the playhead must
  // be ready before playback continues; the next one is fetched ahead of time.
  function asrPlan(windows, time, duration, size = 180, lead = 120) {
    const current = Math.floor(time / size) * size;
    const settled = (start) => windows.get(start) === "ready" || windows.get(start) === "failed";
    if (!settled(current)) {
      return { pause: true, load: windows.has(current) ? null : current };
    }
    const next = current + size;
    if (next < duration - 1 && time >= next - lead && !windows.has(next)) {
      return { pause: false, load: next };
    }
    return { pause: false, load: null };
  }

  // Index of the next cue to voice after the cue list changed under a playing
  // phrase: the phrase that is sounding must not be picked again.
  function resumeIndex(cues, time, active) {
    let index = cueAt(cues, time);
    while (index < cues.length && (cues[index] === active || cues[index].played)
      && cues[index].start <= time) index++;
    return index;
  }

  // Large answers arrive in parts (chunkIndex of chunkCount). Returns the joined
  // text once every part is in, null until then. Counts parts rather than
  // looking for gaps: `new Array(n)` is sparse, and some() skips holes, so a
  // gap check passes after the first part and hands over a truncated WAV.
  function collectChunk(store, id, index, count, part) {
    const entry = store.get(id) || { parts: [], received: 0 };
    if (entry.parts[index] === undefined) entry.received++;
    entry.parts[index] = part;
    store.set(id, entry);
    if (entry.received < count) return null;
    store.delete(id);
    return entry.parts.join("");
  }

  const api = { cueAt, nextPending, startup, decide, asrPlan, resumeIndex, collectChunk };
  root.DubScheduler = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : self);
