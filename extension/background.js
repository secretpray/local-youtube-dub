chrome.runtime.onConnect.addListener((page) => {
  if (page.name !== "dub-session" || !page.sender?.url?.startsWith("https://www.youtube.com/")) {
    page.disconnect();
    return;
  }

  let native;
  try {
    native = chrome.runtime.connectNative("org.local_youtube_dub.host");
  } catch (error) {
    page.postMessage({ ok: false, code: "host_missing", error: error.message });
    return;
  }

  native.onMessage.addListener((message) => {
    try { page.postMessage(message); } catch (_) { /* tab has closed */ }
  });
  // Chrome reports why the host went away only as English text: a missing
  // registration and a crash need different advice, so they get codes.
  native.onDisconnect.addListener(() => {
    const reason = chrome.runtime.lastError?.message || "native host disconnected";
    const code = /not found|forbidden/i.test(reason) ? "host_missing"
      : /exited/i.test(reason) ? "host_exited" : "connection_lost";
    try { page.postMessage({ ok: false, code, error: reason }); } catch (_) { /* tab has closed */ }
  });
  page.onMessage.addListener((message) => {
    try { native.postMessage(message); } catch (error) {
      page.postMessage({ id: message.id, ok: false, code: "connection_lost", error: error.message });
    }
  });
  page.onDisconnect.addListener(() => native.disconnect());
});

// Everything below runs in the page's own world, where the player's API and
// the subtitles kept by page-hook.js are.
function readCaptionTracks() {
  const player = document.getElementById("movie_player");
  const response = player?.getPlayerResponse?.() || window.ytInitialPlayerResponse;
  const list = response?.captions?.playerCaptionsTracklistRenderer;
  // With several audio tracks (YouTube's own dubbing) every dub has its own
  // speech track; the ones tied to the default audio are the original speech.
  const audio = list?.audioTracks?.[list?.defaultAudioTrackIndex ?? 0];
  const original = new Set(audio?.captionTrackIndices || []);
  return {
    videoId: response?.videoDetails?.videoId,
    tracks: (list?.captionTracks || []).map((track, index) => ({
      languageCode: track.languageCode, kind: track.kind, baseUrl: track.baseUrl,
      original: original.has(index),
    })),
  };
}

// Asks the player to load one subtitle track (it adds the token YouTube
// requires), waits for page-hook.js to catch the answer, then puts the
// player's own subtitle choice back as it was.
async function loadCaptionTrack(languageCode) {
  const player = document.getElementById("movie_player");
  const store = window.__ytTranslateTimedtext;
  const videoId = player?.getVideoData?.().video_id;
  const cached = () => store?.get(`${videoId}|${languageCode}`) || null;
  if (!player || !store || !videoId) return null;
  if (cached()) return cached();
  const previous = player.getOption?.("captions", "track");
  player.loadModule?.("captions");
  player.setOption?.("captions", "track", { languageCode });
  for (let waited = 0; waited < 6000 && !cached(); waited += 150) {
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  if (previous?.languageCode) player.setOption?.("captions", "track", { languageCode: previous.languageCode });
  else player.unloadModule?.("captions");
  return cached();
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const tasks = { "get-caption-tracks": [readCaptionTracks, []],
    "load-caption-track": [loadCaptionTrack, [String(message?.languageCode || "")]] };
  const task = tasks[message?.type];
  if (!task) return;
  if (!sender.tab?.id || !sender.url?.startsWith("https://www.youtube.com/watch")) {
    sendResponse(null);
    return;
  }
  chrome.scripting.executeScript({
    target: { tabId: sender.tab.id }, world: "MAIN", func: task[0], args: task[1],
  }).then((results) => sendResponse(results[0]?.result ?? null))
    .catch(() => sendResponse(null));
  return true;
});

// The toolbar icon shows or hides the on-page panel; it is the way back after
// the panel's close button.
chrome.action.onClicked.addListener((tab) => {
  if (!tab.id || !tab.url?.startsWith("https://www.youtube.com/")) return;
  chrome.tabs.sendMessage(tab.id, { type: "toggle-panel" }).catch(() => {});
});
