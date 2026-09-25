/* Subtitle extraction and cue grouping. Kept separate from playback for testing. */
(function (root) {
  function extractAssignedObject(source, marker) {
    const at = source.indexOf(marker);
    if (at < 0) return null;
    const start = source.indexOf("{", at + marker.length);
    if (start < 0) return null;
    let depth = 0;
    let quoted = false;
    let escaped = false;
    for (let index = start; index < source.length; index++) {
      const char = source[index];
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') quoted = false;
      } else if (char === '"') quoted = true;
      else if (char === "{") depth++;
      else if (char === "}" && --depth === 0) {
        try { return JSON.parse(source.slice(start, index + 1)); }
        catch (_) { return null; }
      }
    }
    return null;
  }

  function findPlayerResponse(doc, videoId) {
    for (const script of doc.scripts) {
      const text = script.textContent || "";
      if (!text.includes("ytInitialPlayerResponse")) continue;
      const response = extractAssignedObject(text, "ytInitialPlayerResponse =");
      if (!response?.captions?.playerCaptionsTracklistRenderer?.captionTracks) continue;
      if (videoId && response.videoDetails?.videoId !== videoId) continue;
      return response;
    }
    return null;
  }

  // Manual subtitles first, then speech recognition of the original audio:
  // a video YouTube dubs itself has a recognised track for every dub, and only
  // the original's matches what the speaker says.
  function pickTrack(tracks, preferred) {
    const eligible = tracks.filter((track) => /^(en|es|de)(-|$)/i.test(track.languageCode || ""));
    const matching = preferred === "auto" ? eligible : eligible.filter((track) =>
      track.languageCode.toLowerCase().startsWith(preferred));
    const rank = (track) => (track.kind ? 2 : 0) + (track.original ? 0 : 1);
    return [...matching].sort((a, b) => rank(a) - rank(b))[0] || null;
  }

  function parseJson3(data) {
    if (!Array.isArray(data?.events)) return [];
    return data.events.map((event) => {
      const start = Number(event.tStartMs) / 1000;
      const duration = Number(event.dDurationMs) / 1000;
      const text = (event.segs || []).map((seg) => seg.utf8 || "").join("")
        .replace(/\s+/g, " ").trim();
      return { start, end: start + duration, text };
    }).filter((event) => Number.isFinite(event.start) && Number.isFinite(event.end)
      && event.end > event.start && event.text);
  }

  function parseTime(value) {
    if (!/^\d+(?::\d{1,2}){1,2}$/.test(value.trim())) return NaN;
    const parts = value.trim().split(":").map(Number);
    if (!parts.length || parts.some((part) => !Number.isFinite(part))) return NaN;
    return parts.reduce((total, part) => total * 60 + part, 0);
  }

  function readTranscriptDOM(doc, duration) {
    const nodes = [...doc.querySelectorAll("ytd-transcript-segment-renderer")];
    const segments = nodes.map((node) => ({
      start: parseTime(node.querySelector(".segment-timestamp")?.textContent || ""),
      text: node.querySelector(".segment-text")?.textContent?.replace(/\s+/g, " ").trim() || "",
    })).filter((item) => Number.isFinite(item.start) && item.text);
    segments.sort((a, b) => a.start - b.start);
    return segments.map((item, index) => ({
      ...item,
      end: segments[index + 1]?.start || Math.min(duration || Infinity, item.start + 5),
    })).filter((item) => item.end > item.start);
  }

  // Sound labels and lines with no letters at all ("♪", "...") have nothing to
  // voice; sent anyway they come back as empty audio.
  function isNonSpeech(text) {
    return !/\p{L}/u.test(text)
      || /^\s*[\[(（【].*(music|applause|laughter|música|aplausos|risas|musik|applaus|lachen|смех|музыка|аплодисменты|сміх|музика|оплески).*[\])）】]\s*$/i.test(text);
  }

  function groupSegments(segments) {
    const cues = [];
    let group = null;
    const sorted = segments.filter((segment) => !isNonSpeech(segment.text))
      .sort((a, b) => a.start - b.start);
    for (let index = 0; index < sorted.length; index++) {
      const segment = sorted[index];
      if (!group) group = { start: segment.start, end: segment.end, text: "" };
      group.end = Math.max(group.end, segment.end);
      group.text += (group.text ? " " : "") + segment.text;
      const next = sorted[index + 1];
      const gap = next ? next.start - group.end : Infinity;
      const duration = group.end - group.start;
      const sentenceEnd = /[.!?…]["»)]?$/.test(segment.text);
      if (!next || duration >= 8 || group.text.length >= 320
        || (duration >= 2.5 && (gap >= 0.6 || sentenceEnd))) {
        cues.push(group);
        group = null;
      }
    }
    return cues.filter((cue) => cue.end > cue.start && cue.text.trim());
  }

  // Subtitle text for a track. YouTube answers a plain request for a track
  // without its proof-of-origin token with an empty body, so the player is
  // asked to load it first (loadTrack); the direct request stays as a second
  // try for when YouTube does serve it.
  async function loadJson3(track, fetcher, loadTrack) {
    try {
      const body = await loadTrack?.(track);
      if (body) return { data: JSON.parse(body), via: "player" };
    } catch (_) { /* fall through to the direct request */ }
    try {
      const url = new URL(track.baseUrl);
      url.searchParams.set("fmt", "json3");
      const result = await fetcher(url.toString(), { credentials: "same-origin" });
      const body = result.ok ? await result.text() : "";
      if (body) return { data: JSON.parse(body), via: "direct" };
    } catch (_) { /* no usable answer */ }
    return null;
  }

  async function read(doc, duration, preferred, fetcher, externalTracks, loadTrack) {
    let videoId = null;
    try { videoId = new URL(doc.location.href).searchParams.get("v"); } catch (_) { /* test document */ }
    const response = findPlayerResponse(doc, videoId);
    const tracks = externalTracks?.videoId === videoId && externalTracks?.tracks?.length
      ? externalTracks.tracks
      : response?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
    const track = pickTrack(tracks, preferred);
    if (track?.baseUrl) {
      const loaded = await loadJson3(track, fetcher, loadTrack);
      const segments = loaded ? parseJson3(loaded.data) : [];
      if (segments.length) return {
        source: "caption-track",
        language: track.languageCode,
        automatic: track.kind === "asr",
        via: loaded.via,
        segments,
      };
    }
    const segments = readTranscriptDOM(doc, duration);
    return segments.length ? { source: "transcript-panel", language: preferred, segments } : null;
  }

  const api = { isNonSpeech, extractAssignedObject, findPlayerResponse, pickTrack, parseJson3,
    readTranscriptDOM, groupSegments, read };
  root.DubSubtitles = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : self);
