(() => {
  if (window.__localYoutubeDubLoaded) return;
  window.__localYoutubeDubLoaded = true;

  const ASR_WINDOW = 180;
  const REQUEST_TIMEOUT_MS = 45_000;

  let session = null;
  let preparation = null;
  let sequence = 0;
  // Bumped by every start and stop: a start() that resumes after an await and
  // finds a newer attempt has been superseded and must not create a session.
  let attempt = 0;
  const log = [];

  const panel = DubPanel.create({
    onStart: start,
    onStop: () => stop({ key: "status.off" }),
    onPause: togglePause,
    onSettingsChange: (settings, patch) => {
      if (!session) return;
      if ("voice" in patch) session.gain.gain.value = settings.voice / 100;
      if ("original" in patch && session.source) applyDucking(session);
    },
    onCopyLog: () => [`${location.href}`, panel.host.dataset.metrics || "", ...log].join("\n"),
  });
  const host = panel.host;

  // Statuses are message keys (see i18n.js); the journal gets the key too.
  function setStatus(key, tone, params) {
    const message = typeof key === "object" ? key : { key, params };
    if (host.dataset.statusKey !== message.key) note(`status: ${message.key}`);
    panel.setStatus(message, undefined, tone);
  }

  // An error from the local app as a message: its code picks the text, and the
  // English detail is kept for when the code is unknown to this version.
  function hostError(reply) {
    return { key: `error.${reply?.code || "internal"}`, params: reply?.params, fallback: reply?.error };
  }

  // Last events of the session: when dubbing stalls this is what tells a stuck
  // request from a paused player or a missing recognition window.
  function note(event) {
    log.push(`${new Date().toTimeString().slice(0, 8)} ${event}`);
    if (log.length > 60) log.shift();
    host.dataset.log = log.slice(-30).join("\n");
  }

  function showPanel() { panel.setVisibleOnPage(location.pathname === "/watch"); }
  showPanel();
  document.addEventListener("yt-navigate-finish", () => { stop(); showPanel(); });
  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === "toggle-panel") panel.toggleHidden();
    // Only the extension itself can send this; the end-to-end check uses it
    // instead of clicking into the closed shadow root.
    if (message?.type === "start-dub") start();
  });

  function stop(status = { key: "status.ready" }) {
    attempt++;
    if (preparation) {
      const p = preparation;
      preparation = null;
      p.cancelled = true;
      clearInterval(p.timer);
      p.port.disconnect();
      p.audioContext.close();
      if (p.wasPlaying) p.video.play().catch(() => {});
    }
    if (session) {
      const s = session;
      const resumeVideo = s.waitingToStart || s.pausedForVoice || s.pausedForCue || s.pausedForAsr;
      s.stopped = true;
      clearInterval(s.timer);
      s.abort.abort();
      try { s.source?.stop(); } catch (_) { /* already finished */ }
      s.port.disconnect();
      s.video.volume = s.userVolume;
      s.video.playbackRate = s.userRate;
      if (resumeVideo) s.video.play().catch(() => {});
      s.audioContext.close();
      session = null;
    }
    panel.setMode("idle");
    setStatus(status, "idle");
  }

  function fail(message) {
    note(`fail: ${message.key} ${message.fallback || ""}`);
    stop();
    setStatus(message, "error");
  }

  // Pause the dub, not the video: the voice stops, the original comes back to
  // full volume, and phrases keep being prepared so resuming is instant.
  function togglePause() {
    const s = session;
    if (!s || s.waitingToStart) return;
    s.muted = !s.muted;
    note(s.muted ? "dub paused" : "dub resumed");
    if (s.muted) {
      try { s.source?.stop(); } catch (_) { /* already finished */ }
      s.source = null;
      const internalPause = s.pausedForVoice || s.pausedForCue || s.pausedForAsr;
      s.pausedForVoice = s.pausedForCue = s.pausedForAsr = false;
      setVideoVolume(s, s.userVolume);
      setVideoRate(s, s.userRate);
      if (internalPause) s.video.play().catch(() => {});
      panel.setCaption("");
      panel.setMode("paused");
      setStatus("status.paused", "paused");
    } else {
      s.nextIndex = DubScheduler.cueAt(s.cues, s.video.currentTime);
      panel.setMode("active");
      setStatus("status.live", "live");
    }
  }

  function setVideoVolume(s, value) {
    s.pendingVolume = value;
    s.video.volume = value;
  }

  function setVideoRate(s, value) {
    s.pendingRate = value;
    s.video.playbackRate = value;
  }

  function applyDucking(s) {
    setVideoVolume(s, s.userVolume * panel.settings.original / 100);
  }

  // Between two close phrases the original stays ducked: bringing it up for a
  // second and down again pumps the volume on every sentence.
  function nextCueSoon(s) {
    const next = s.cues[s.nextIndex];
    return !!next && !next.failed && next.start - s.video.currentTime < 1.5;
  }

  function restoreOriginal(s, keepDucked = false) {
    if (!s.stopped) {
      if (!keepDucked) setVideoVolume(s, s.userVolume);
      setVideoRate(s, s.userRate);
    }
    s.source = null;
  }

  function playCue(s, cue) {
    const source = s.audioContext.createBufferSource();
    source.buffer = cue.buffer;
    const available = Math.max(0.1, cue.end - cue.start);
    if (cue.buffer.duration > available && Math.abs(s.userRate - 1) < 0.01) {
      s.video.preservesPitch = true;
      setVideoRate(s, 0.9);
    }
    source.connect(s.gain);
    source.onended = () => {
      if (s.source !== source) return;
      restoreOriginal(s, nextCueSoon(s));
      if (s.pausedForVoice && !s.stopped) {
        s.pausedForVoice = false;
        s.video.play().catch(() => setStatus("status.pressPlay", "busy"));
        setStatus("status.live", "live");
      }
    };
    applyDucking(s);
    panel.setCaption(cue.translated || "");
    s.playedCount++;
    cue.played = true;
    host.dataset.played = String(s.playedCount);
    s.source = source;
    s.activeCue = cue;
    source.start();
  }

  function pauseVideoFor(s, flag, key) {
    if (s[flag]) return;
    s[flag] = true;
    s.pauseStartedAt = performance.now();
    s.video.pause();
    setStatus(key, "busy");
  }

  function showRunning(s) {
    if (s.muted) setStatus("status.paused", "paused");
    else setStatus("status.live", "live");
  }

  function resumeVideoFrom(s, flag) {
    if (!s[flag]) return;
    s[flag] = false;
    s.video.play().catch(() => setStatus("status.pressPlay", "busy"));
    showRunning(s);
  }

  function tick(s) {
    updateMetrics(s);
    if (s.stopped) return;
    expireRequests(s);
    if (playerFailed()) {
      fail({ key: "status.playerError" });
      return;
    }
    // An ad plays in the same <video> from 0:00; the dub steps aside until the
    // programme is back instead of treating it as a seek to the start.
    if (adShowing()) {
      if (!s.inAd) {
        s.inAd = true;
        note("ad started");
        try { s.source?.stop(); } catch (_) { /* already finished */ }
        s.source = null;
        s.pausedForVoice = s.pausedForCue = s.pausedForAsr = false;
        setVideoVolume(s, s.userVolume);
        setStatus("status.ad", "paused");
      }
      return;
    }
    if (s.inAd) {
      s.inAd = false;
      note(`ad ended at ${formatTime(s.video.currentTime)}`);
      s.nextIndex = DubScheduler.cueAt(s.cues, s.video.currentTime);
      showRunning(s);
    }
    // YouTube's player sometimes resumes on its own after an external pause();
    // until the first phrases are ready the video has to stay put.
    if (s.waitingToStart && !s.video.paused) s.video.pause();
    if (s.waitingToStart || s.video.paused && !s.pausedForVoice && !s.pausedForCue && !s.pausedForAsr) return;
    const time = s.video.currentTime;
    if (s.asrVideoId) {
      const plan = DubScheduler.asrPlan(s.asrWindows, time, s.video.duration, ASR_WINDOW);
      if (plan.load != null && !s.asrLoading) requestAsrWindow(s, plan.load);
      if (plan.pause && !s.muted) {
        if (!s.source) pauseVideoFor(s, "pausedForAsr", "status.recognizingHere");
        if (!s.source) return;
      } else {
        resumeVideoFrom(s, "pausedForAsr");
      }
    }
    if (s.muted) {
      // Keep the position current so resuming starts from here, not from a backlog.
      s.nextIndex = DubScheduler.cueAt(s.cues, time);
      sendNext(s);
      return;
    }
    const decision = DubScheduler.decide(s.cues, s.nextIndex, time,
      s.source ? s.activeCue.end : null);
    s.nextIndex = decision.nextIndex;
    if (decision.action === "pause-voice") {
      pauseVideoFor(s, "pausedForVoice", "status.finishing");
      return;
    }
    if (decision.action === "pause-cue") {
      pauseVideoFor(s, "pausedForCue", "status.waitingPhrase");
      return;
    }
    if (decision.action === "play") {
      note(`play ${formatTime(decision.cue.start)}-${formatTime(decision.cue.end)} voice ${decision.cue.buffer.duration.toFixed(1)} s`);
      playCue(s, decision.cue);
      if (host.dataset.statusKey !== "status.live") setStatus("status.live", "live");
    }
  }

  // A phrase whose answer never comes back would hold its in-flight slot
  // forever, and with both slots held nothing else is ever requested.
  function expireRequests(s) {
    const now = performance.now();
    for (const cue of s.cues) {
      if (!cue.requested || cue.buffer || cue.failed || now - cue.requestedAt < REQUEST_TIMEOUT_MS) continue;
      note(`timeout: phrase ${cue.id} at ${formatTime(cue.start)}`);
      skipCue(s, cue, { key: "reason.timeout", params: { seconds: REQUEST_TIMEOUT_MS / 1000 } });
    }
  }

  function skipCue(s, cue, reason) {
    cue.failed = true;
    s.failedCount++;
    s.inFlight = Math.max(0, s.inFlight - 1);
    note(`skip ${formatTime(cue.start)}: ${reason.key} ${reason.fallback || ""}`);
    panel.warn({ key: "warn.skipped", params: { text: cue.text.slice(0, 110), reason } });
    readyToPlay(s);
    sendNext(s);
    if (s.pausedForCue && s.cues[s.nextIndex] === cue) resumeVideoFrom(s, "pausedForCue");
  }

  function adShowing() {
    return !!document.querySelector("#movie_player.ad-showing, #movie_player.ad-interrupting");
  }

  function playerFailed() {
    const error = document.querySelector("#movie_player .ytp-error");
    return !!error && error.offsetParent !== null;
  }

  function updateMetrics(s) {
    const now = performance.now();
    if (now - s.lastMetricsAt < 1000) return;
    s.lastMetricsAt = now;
    let readyUntil = s.video.currentTime;
    for (let index = s.nextIndex; index < s.cues.length; index++) {
      if (!s.cues[index].buffer && !s.cues[index].failed) break;
      readyUntil = s.cues[index].end;
    }
    const ahead = Math.max(0, readyUntil - s.video.currentTime);
    const prepared = s.cues.filter((cue) => cue.preparationMs != null);
    const work = prepared.reduce((sum, cue) => sum + cue.preparationMs, 0) / 1000;
    const speech = prepared.reduce((sum, cue) => sum + (cue.end - cue.start), 0);
    const paused = s.pausedMs + (s.pauseStartedAt == null ? 0 : now - s.pauseStartedAt);
    const share = s.playStartedAt == null ? 0 : paused / Math.max(1, now - s.playStartedAt) * 100;
    panel.setBuffer(ahead);
    panel.setMetrics({ ahead: Math.round(ahead), speed: work ? speech / work : 0, stops: share,
      voiced: s.playedCount, skipped: s.failedCount, source: s.sourceKind,
      from: s.language, into: s.into });
  }

  function readyToPlay(s) {
    if (!s.waitingToStart) return;
    const { prepared, ready } = DubScheduler.startup(s.cues, s.nextIndex, s.startTime);
    if (ready) {
      s.waitingToStart = false;
      s.playStartedAt = performance.now();
      panel.setMode("active");
      setStatus("status.live", "live");
      s.video.play().catch(() => setStatus("status.pressPlay", "busy"));
    } else {
      setStatus("status.warming", "busy", { done: prepared });
    }
  }

  function decodeBase64(text) {
    const binary = atob(text);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  }

  async function receive(s, message) {
    if (s.stopped) return;
    if (message.id == null && !message.ok) {
      fail(hostError({ code: "connection_lost", ...message }));
      return;
    }
    if (message.chunkCount > 1) {
      const json = message.resultJsonBase64 != null;
      const joined = DubScheduler.collectChunk(json ? s.asrChunks : s.chunks, message.id,
        message.chunkIndex, message.chunkCount, json ? message.resultJsonBase64 : message.result.wavBase64);
      if (joined === null) return;
      message = json
        ? { ...message, result: JSON.parse(new TextDecoder().decode(decodeBase64(joined))) }
        : { ...message, result: { ...message.result, wavBase64: joined } };
    }
    if (message.id === "status") {
      if (!message.ok) {
        fail(hostError(message));
        return;
      }
      s.statusReady = true;
      sendNext(s);
      return;
    }
    if (typeof message.id === "string" && message.id.startsWith("asr:")) {
      receiveWindow(s, message);
      return;
    }
    const cue = s.cues.find((item) => item.id === message.id);
    if (!cue || cue.failed) return;
    if (!message.ok) {
      skipCue(s, cue, hostError(message));
      return;
    }
    try {
      cue.buffer = await s.audioContext.decodeAudioData(decodeBase64(message.result.wavBase64).buffer);
    } catch (error) {
      if (!s.stopped) skipCue(s, cue, { key: "reason.decode", fallback: error.message });
      return;
    }
    // The session may have been stopped while the audio was decoding.
    if (s.stopped) return;
    s.inFlight = Math.max(0, s.inFlight - 1);
    cue.translated = message.result.translated;
    cue.preparationMs = performance.now() - cue.requestedAt;
    readyToPlay(s);
    sendNext(s);
    if (s.pausedForCue && s.cues[s.nextIndex] === cue) resumeVideoFrom(s, "pausedForCue");
  }

  function receiveWindow(s, message) {
    s.asrLoading = false;
    const windowStart = Number(message.id.slice(4));
    if (!message.ok) {
      s.asrWindows.set(windowStart, "failed");
      // One retry: a transient failure should not silence three minutes.
      if (!s.asrRetries.has(windowStart)) {
        s.asrRetries.add(windowStart);
        setTimeout(() => { if (!s.stopped) s.asrWindows.delete(windowStart); }, 10_000);
      }
      note(`asr failed ${formatTime(windowStart)}: ${message.error}`);
      panel.warn({ key: "warn.window", params: { time: formatTime(windowStart), reason: hostError(message) } });
      return;
    }
    s.asrWindows.set(windowStart, "ready");
    note(`asr ready ${formatTime(windowStart)}: ${message.result.segments.length} segments`);
    const added = DubSubtitles.groupSegments(message.result.segments);
    s.cues = s.cues.concat(added).sort((a, b) => a.start - b.start);
    s.nextIndex = DubScheduler.resumeIndex(s.cues, s.video.currentTime, s.source ? s.activeCue : null);
    sendNext(s);
  }

  function sendNext(s) {
    if (!s.statusReady) return;
    while (!s.stopped && s.inFlight < 2) {
      const index = DubScheduler.nextPending(s.cues, s.nextIndex);
      if (index < 0) return;
      const cue = s.cues[index];
      cue.id = ++sequence;
      cue.requested = true;
      cue.requestedAt = performance.now();
      s.inFlight++;
      s.port.postMessage({
        id: cue.id, type: "translate", source: cue.text, language: s.language, into: s.into,
        targetDuration: Math.max(1, cue.end - cue.start),
        contextBefore: s.cues.slice(Math.max(0, index - 2), index).map((item) => item.text).join(" ").slice(-500),
        contextAfter: s.cues.slice(index + 1, index + 3).map((item) => item.text).join(" ").slice(0, 500),
      });
    }
  }

  function requestAsrWindow(s, startSeconds) {
    if (s.asrLoading || s.stopped) return;
    s.asrLoading = true;
    s.asrWindows.set(startSeconds, "loading");
    note(`asr request ${formatTime(startSeconds)}`);
    s.port.postMessage({
      id: `asr:${startSeconds}`, type: "transcribe", videoId: s.asrVideoId,
      startSeconds, windowSeconds: ASR_WINDOW, language: s.language,
    });
  }

  function formatTime(seconds) {
    const minutes = Math.floor(seconds / 60);
    return `${minutes}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
  }

  function requestOnce(port, request) {
    return new Promise((resolve, reject) => {
      const parts = [];
      const clean = () => {
        port.onMessage.removeListener(onMessage);
        port.onDisconnect.removeListener(onDisconnect);
      };
      const fault = (reply) => Object.assign(new Error(reply.error || reply.code), { reply });
      const onDisconnect = () => {
        clean();
        reject(fault({ code: "connection_lost" }));
      };
      const onMessage = (message) => {
        if (message.id !== request.id && message.id != null) return;
        if (!message.ok) {
          clean();
          reject(fault(message));
          return;
        }
        if (message.resultJsonBase64 && message.chunkCount > 1) {
          const joined = DubScheduler.collectChunk(parts, request.id, message.chunkIndex,
            message.chunkCount, message.resultJsonBase64);
          if (joined === null) return;
          message.result = JSON.parse(new TextDecoder().decode(decodeBase64(joined)));
        }
        clean();
        resolve(message.result);
      };
      port.onMessage.addListener(onMessage);
      port.onDisconnect.addListener(onDisconnect);
      port.postMessage(request);
    });
  }

  // Without subtitles the audio is recognised locally, starting with the
  // window under the playhead; the session then continues window by window.
  async function recognise(video, audioContext) {
    const videoId = new URL(location.href).searchParams.get("v");
    if (!videoId) throw Object.assign(new Error("no video id"), { reply: { code: "bad_request" } });
    const wasPlaying = !video.paused;
    video.pause();
    const port = chrome.runtime.connect({ name: "dub-session" });
    const p = { port, audioContext, video, wasPlaying, cancelled: false };
    preparation = p;
    const startedAt = Date.now();
    const show = () => setStatus("status.recognizing", "busy",
      { seconds: Math.floor((Date.now() - startedAt) / 1000) });
    show();
    p.timer = setInterval(show, 1000);
    try {
      await requestOnce(port, { id: "preflight", type: "status", into: panel.into });
      const result = await requestOnce(port, {
        id: "transcription", type: "transcribe", videoId,
        startSeconds: Math.floor(video.currentTime / ASR_WINDOW) * ASR_WINDOW,
        windowSeconds: ASR_WINDOW, language: panel.settings.language,
      });
      return p.cancelled ? null : result;
    } catch (error) {
      if (p.cancelled) return null;
      if (wasPlaying) video.play().catch(() => {});
      throw error;
    } finally {
      clearInterval(p.timer);
      if (preparation === p) preparation = null;
      port.disconnect();
    }
  }

  async function start() {
    stop();
    const current = attempt;
    const superseded = async (context) => {
      if (current === attempt) return false;
      await context.close();
      return true;
    };
    const video = document.querySelector("video.html5-main-video") || document.querySelector("video");
    if (!video) { setStatus("status.noPlayer", "error"); return; }
    const audioContext = new AudioContext();
    await audioContext.resume();
    panel.warn("");
    panel.setMode("preparing");
    // While an ad plays the player belongs to the ad: its subtitle requests
    // are for the ad's video and come back empty. Subtitles wait for the video.
    if (adShowing()) {
      setStatus("status.ad", "paused");
      while (adShowing()) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        if (await superseded(audioContext)) return;
      }
    }
    setStatus("status.searching", "busy");
    const currentTracks = await chrome.runtime.sendMessage({ type: "get-caption-tracks" })
      .catch(() => null);
    let subtitles = await DubSubtitles.read(
      document, video.duration, panel.settings.language,
      (...args) => fetch(...args), currentTracks,
      (track) => chrome.runtime.sendMessage({ type: "load-caption-track", languageCode: track.languageCode })
        .catch(() => null));
    note(subtitles ? `subtitles: ${subtitles.source} ${subtitles.language} via ${subtitles.via || "page"}`
      : `subtitles: none usable among ${currentTracks?.tracks?.length || 0} tracks`);
    if (await superseded(audioContext)) return;
    if (!subtitles) {
      try {
        subtitles = await recognise(video, audioContext);
      } catch (error) {
        await audioContext.close();
        fail({ key: "status.recognitionFailed",
          params: { reason: error.reply ? hostError(error.reply) : error.message } });
        return;
      }
      if (!subtitles || await superseded(audioContext)) { await audioContext.close().catch(() => {}); return; }
    }
    const cues = DubSubtitles.groupSegments(subtitles.segments);
    const startTime = video.currentTime;
    const firstCue = DubScheduler.cueAt(cues, startTime);
    if (firstCue >= cues.length) {
      await audioContext.close();
      fail({ key: "status.noSpeechAhead" });
      return;
    }
    const gain = audioContext.createGain();
    gain.gain.value = panel.settings.voice / 100;
    gain.connect(audioContext.destination);
    video.pause();
    const port = chrome.runtime.connect({ name: "dub-session" });
    const detected = /^(en|es|de)/i.exec(subtitles.language || "")?.[1].toLowerCase();
    const language = panel.settings.language === "auto" ? detected || "auto" : panel.settings.language;
    const s = {
      video, cues, port, audioContext, gain, userVolume: video.volume,
      userRate: video.playbackRate, pendingVolume: null, pendingRate: null,
      source: null, stopped: false, muted: false, statusReady: false, nextIndex: firstCue,
      waitingToStart: true, pausedForVoice: false, pausedForCue: false, pausedForAsr: false,
      startTime, inFlight: 0, playedCount: 0, chunks: new Map(), asrChunks: new Map(), failedCount: 0,
      sourceKind: subtitles.source,
      asrVideoId: subtitles.source === "audio-recognition" ? new URL(location.href).searchParams.get("v") : null,
      asrWindows: new Map(subtitles.source === "audio-recognition"
        ? [[subtitles.windowStart, "ready"]] : []),
      asrLoading: false, asrRetries: new Set(),
      startedAt: performance.now(), playStartedAt: null, lastMetricsAt: 0,
      pausedMs: 0, pauseStartedAt: null, language, into: panel.into,
      abort: new AbortController(),
    };
    session = s;
    note(`start at ${formatTime(startTime)}: ${cues.length} phrases from ${subtitles.source}, ${language} -> ${s.into}`);
    port.onMessage.addListener((message) => receive(s, message));
    port.onDisconnect.addListener(() => {
      note("port disconnected");
      if (!s.stopped) fail({ key: "error.connection_lost" });
    });
    port.postMessage({ id: "status", type: "status", into: s.into });
    video.addEventListener("seeking", () => {
      if (s.stopped || adShowing()) return;
      note(`seek to ${formatTime(video.currentTime)}`);
      const wasInternalPause = s.pausedForVoice || s.pausedForCue || s.pausedForAsr;
      s.pausedForVoice = s.pausedForCue = s.pausedForAsr = false;
      try { s.source?.stop(); } catch (_) { /* already finished */ }
      s.source = null;
      setVideoVolume(s, s.userVolume);
      setVideoRate(s, s.userRate);
      s.nextIndex = DubScheduler.cueAt(s.cues, video.currentTime);
      sendNext(s);
      if (wasInternalPause) video.play().catch(() => {});
    }, { signal: s.abort.signal });
    video.addEventListener("volumechange", () => {
      if (s.stopped) return;
      if (s.pendingVolume !== null && Math.abs(video.volume - s.pendingVolume) < 0.001) {
        s.pendingVolume = null;
        return;
      }
      s.userVolume = video.volume;
      if (s.source) applyDucking(s);
    }, { signal: s.abort.signal });
    video.addEventListener("ratechange", () => {
      if (s.stopped) return;
      if (s.pendingRate !== null && Math.abs(video.playbackRate - s.pendingRate) < 0.001) {
        s.pendingRate = null;
        return;
      }
      s.userRate = video.playbackRate;
    }, { signal: s.abort.signal });
    video.addEventListener("pause", () => {
      if (!s.stopped && !s.waitingToStart && !s.pausedForVoice && !s.pausedForCue && !s.pausedForAsr) {
        s.audioContext.suspend();
      }
    }, { signal: s.abort.signal });
    video.addEventListener("play", () => {
      if (s.stopped) return;
      s.audioContext.resume();
      if (s.pauseStartedAt != null) {
        s.pausedMs += performance.now() - s.pauseStartedAt;
        s.pauseStartedAt = null;
      }
    }, { signal: s.abort.signal });
    s.timer = setInterval(() => tick(s), 80);
    setStatus("status.warming", "busy", { done: 0 });
  }
})();
