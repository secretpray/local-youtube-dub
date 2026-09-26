const test = require("node:test");
const assert = require("node:assert/strict");
const subtitles = require("../extension/subtitles.js");
const scheduler = require("../extension/scheduler.js");

test("extracts caption tracks from YouTube player data", () => {
  const response = { captions: { playerCaptionsTracklistRenderer: { captionTracks: [
    { languageCode: "es", kind: "asr", baseUrl: "https://www.youtube.com/api/timedtext?v=1" },
  ] } } };
  const doc = { scripts: [{ textContent: `var ytInitialPlayerResponse = ${JSON.stringify(response)};var next = {};` }] };
  assert.equal(subtitles.findPlayerResponse(doc).captions.playerCaptionsTracklistRenderer.captionTracks[0].languageCode, "es");
});

test("parses json3 timestamps and groups automatic captions by pauses", () => {
  const segments = subtitles.parseJson3({ events: [
    { tStartMs: 1000, dDurationMs: 2200, segs: [{ utf8: "Hola " }, { utf8: "a todos" }] },
    { tStartMs: 3200, dDurationMs: 1200, segs: [{ utf8: "bienvenidos" }] },
    { tStartMs: 5400, dDurationMs: 2400, segs: [{ utf8: "al canal" }] },
    { tStartMs: 8000, dDurationMs: 1000, segs: [{ utf8: "[Música]" }] },
  ] });
  assert.deepEqual(segments[0], { start: 1, end: 3.2, text: "Hola a todos" });
  const cues = subtitles.groupSegments(segments);
  assert.equal(cues.length, 2);
  assert.equal(cues[0].text, "Hola a todos bienvenidos");
  assert.equal(cues[1].text, "al canal");
});

test("prefers a manual subtitle track in the requested language", () => {
  const tracks = [
    { languageCode: "en-US", kind: "asr" },
    { languageCode: "en" },
    { languageCode: "es" },
  ];
  assert.equal(subtitles.pickTrack(tracks, "en").languageCode, "en");
  assert.equal(subtitles.pickTrack(tracks, "es").languageCode, "es");
});

test("keeps a DOM transcript fallback", async () => {
  const doc = {
    scripts: [],
    querySelectorAll: () => [
      { querySelector: (selector) => ({ textContent: selector === ".segment-timestamp" ? "1:02" : "Hello" }) },
      { querySelector: (selector) => ({ textContent: selector === ".segment-timestamp" ? "1:05" : "world" }) },
    ],
  };
  const result = await subtitles.read(doc, 70, "en", () => { throw Error("no fetch"); });
  assert.equal(result.source, "transcript-panel");
  assert.deepEqual(result.segments.map((item) => item.start), [62, 65]);
});

test("loads json3 from a player caption track when available", async () => {
  const response = { videoDetails: { videoId: "sample" },
    captions: { playerCaptionsTracklistRenderer: { captionTracks: [
    { languageCode: "en", baseUrl: "https://www.youtube.com/api/timedtext?v=sample" },
  ] } } };
  const doc = { location: { href: "https://www.youtube.com/watch?v=sample" },
    scripts: [{ textContent: `var ytInitialPlayerResponse = ${JSON.stringify(response)};` }] };
  let requestedUrl;
  const result = await subtitles.read(doc, 20, "en", async (url) => {
    requestedUrl = url;
    return { ok: true, text: async () => JSON.stringify({ events: [
      { tStartMs: 1500, dDurationMs: 2200, segs: [{ utf8: "Hello" }] },
    ] }) };
  });
  assert.equal(result.source, "caption-track");
  assert.equal(result.via, "direct");
  assert.equal(result.segments[0].start, 1.5);
  assert.equal(new URL(requestedUrl).searchParams.get("fmt"), "json3");
});

test("does not use stale caption data after navigating to another video", async () => {
  const old = { videoDetails: { videoId: "old" }, captions: { playerCaptionsTracklistRenderer: {
    captionTracks: [{ languageCode: "en", baseUrl: "https://www.youtube.com/api/timedtext?v=old" }],
  } } };
  const doc = { location: { href: "https://www.youtube.com/watch?v=new" },
    scripts: [{ textContent: `var ytInitialPlayerResponse = ${JSON.stringify(old)};` }],
    querySelectorAll: () => [],
  };
  const result = await subtitles.read(doc, 20, "en", () => { throw Error("must not fetch"); });
  assert.equal(result, null);
});

test("seeks backward to an unprepared cue and skips one failed cue", () => {
  const cues = [
    { start: 0, end: 4, buffer: true },
    { start: 5, end: 9, failed: true },
    { start: 10, end: 14 },
  ];
  assert.equal(scheduler.cueAt(cues, 1), 0);
  assert.equal(scheduler.nextPending(cues, 2), 2);
  assert.deepEqual(scheduler.decide(cues, 1, 5.2, null), { action: "skip", nextIndex: 2 });
  assert.deepEqual(scheduler.decide(cues, 2, 10.2, null), { action: "pause-cue", nextIndex: 2 });
  assert.equal(scheduler.startup(cues, 0, 0).ready, false);
});

test("recognition waits for the window under the playhead and prefetches the next", () => {
  const windows = new Map([[540, "ready"]]);
  assert.deepEqual(scheduler.asrPlan(windows, 590, 3800), { pause: false, load: null });
  assert.deepEqual(scheduler.asrPlan(windows, 610, 3800), { pause: false, load: 720 });
  windows.set(720, "loading");
  assert.deepEqual(scheduler.asrPlan(windows, 725, 3800), { pause: true, load: null });
  assert.deepEqual(scheduler.asrPlan(windows, 2000, 3800), { pause: true, load: 1980 });
  windows.set(1980, "failed");
  assert.deepEqual(scheduler.asrPlan(windows, 2000, 3800), { pause: false, load: null });
  assert.deepEqual(scheduler.asrPlan(new Map([[3780, "ready"]]), 3790, 3800), { pause: false, load: null });
});

test("merging a recognised window does not replay the sounding phrase", () => {
  const active = { start: 10, end: 14, played: true };
  const cues = [{ start: 2, end: 6, played: true }, active, { start: 15, end: 19 }];
  assert.equal(scheduler.resumeIndex(cues, 12, active), 2);
  assert.equal(scheduler.resumeIndex(cues, 1, null), 0);
});

test("lines without letters are not sent for voicing", () => {
  assert.equal(subtitles.isNonSpeech("♪ ♪"), true);
  assert.equal(subtitles.isNonSpeech("..."), true);
  assert.equal(subtitles.isNonSpeech("[Music]"), true);
  assert.equal(subtitles.isNonSpeech("Hola, ¿qué tal?"), false);
});

const fs = require("node:fs");
const path = require("node:path");
const i18n = require("../extension/i18n.js");
const read = (file) => fs.readFileSync(path.join(__dirname, "..", file), "utf8");

test("picks German subtitle tracks and German sound labels", () => {
  const tracks = [{ languageCode: "fr" }, { languageCode: "de", kind: "asr" }];
  assert.equal(subtitles.pickTrack(tracks, "auto").languageCode, "de");
  assert.equal(subtitles.pickTrack(tracks, "de").languageCode, "de");
  assert.equal(subtitles.isNonSpeech("[Musik]"), true);
  assert.equal(subtitles.isNonSpeech("[Оплески]"), true);
});

test("every interface language has the same messages and placeholders", () => {
  const placeholders = (text) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join();
  const english = i18n.MESSAGES.en;
  for (const locale of i18n.LOCALES) {
    const messages = i18n.MESSAGES[locale];
    assert.deepEqual(Object.keys(messages).sort(), Object.keys(english).sort(), locale);
    for (const [key, text] of Object.entries(messages)) {
      assert.equal(placeholders(text), placeholders(english[key]), `${locale} ${key}`);
      assert.ok(text.trim(), `${locale} ${key} is empty`);
    }
  }
});

test("every message key and error code used by the code has a text", () => {
  const known = new Set(Object.keys(i18n.MESSAGES.en));
  const code = ["extension/content.js", "extension/panel.js"].map(read).join("\n");
  const used = [...code.matchAll(/["'`]((?:status|warn|reason|action|panel|field|section|metric|log|locale|source|unit|buffer)\.[\w-]+)["'`]/g)]
    .map((m) => m[1]);
  assert.ok(used.length > 30);
  for (const key of used) assert.ok(known.has(key), `missing ${key}`);
  const codes = new Set([
    ...[...read("src/main.rs").matchAll(/Failure::new\(\s*"(\w+)"/g)].map((m) => m[1]),
    ...[...read("src/main.rs").matchAll(/\.during\("(\w+)"\)/g)].map((m) => m[1]),
    ...[...read("worker/transcribe_video.py").matchAll(/DubError\("(\w+)"/g)].map((m) => m[1]),
    ...[...read("extension/background.js").matchAll(/"(host_\w+|connection_lost)"/g)].map((m) => m[1]),
  ]);
  assert.ok(codes.size > 15);
  for (const name of codes) assert.ok(known.has(`error.${name}`), `missing error.${name}`);
});

test("interface language follows the browser, with English as the fallback", () => {
  assert.equal(i18n.browserLocale(["uk-UA", "en"]), "uk");
  assert.equal(i18n.browserLocale(["de-DE", "es-MX"]), "es");
  assert.equal(i18n.browserLocale(["fr-FR"]), "en");
  const t = i18n.translator("uk", "linux");
  assert.equal(t("error.voice_missing", { target: "uk" }), "Немає голосу для мови «Українська». Виконайте make setup");
  assert.equal(t("error.not_a_code", {}, "raw detail"), "raw detail");
  assert.equal(i18n.translator("es")("unit.seconds", { value: 3 }), "3 s");
});

test("messages name the commands of the viewer's own system", () => {
  assert.equal(i18n.currentPlatform({ userAgentData: { platform: "Windows" } }), "windows");
  assert.equal(i18n.currentPlatform({ platform: "MacIntel" }), "mac");
  assert.equal(i18n.currentPlatform({ platform: "Linux x86_64" }), "linux");
  assert.equal(i18n.translator("en", "windows")("error.host_missing"),
    "The local app is not installed. Run scripts\\install-host.ps1 and restart the browser");
  assert.equal(i18n.translator("ru", "mac")("error.ffmpeg_missing"),
    "Не найден ffmpeg. Установите: brew install ffmpeg");
  assert.equal(i18n.translator("es", "windows")("error.translator_missing", { engine: "llama-server" }),
    "El motor de traducción (llama-server) no está instalado. Ejecuta scripts\\setup.ps1");
  for (const commands of Object.values(i18n.COMMANDS)) {
    assert.deepEqual(Object.keys(commands).sort(), ["ffmpeg", "install", "setup"]);
  }
});

test("large answers are joined only when every part has arrived", () => {
  const store = new Map();
  assert.equal(scheduler.collectChunk(store, 7, 0, 3, "AA"), null);
  assert.equal(scheduler.collectChunk(store, 7, 2, 3, "CC"), null);
  assert.equal(scheduler.collectChunk(store, 7, 2, 3, "CC"), null, "a repeated part is not a new one");
  assert.equal(scheduler.collectChunk(store, 7, 1, 3, "BB"), "AABBCC");
  assert.equal(store.size, 0);
});

test("subtitles come through the player, since YouTube answers a bare request with nothing", async () => {
  const doc = { location: { href: "https://www.youtube.com/watch?v=abc" }, scripts: [], querySelectorAll: () => [] };
  const tracks = { videoId: "abc", tracks: [
    { languageCode: "de-DE", kind: "asr", baseUrl: "https://www.youtube.com/api/timedtext?lang=de-DE" },
    { languageCode: "en", kind: "asr", original: true, baseUrl: "https://www.youtube.com/api/timedtext?lang=en" },
  ] };
  const emptyFetch = async () => ({ ok: true, text: async () => "" });
  const json3 = JSON.stringify({ events: [{ tStartMs: 0, dDurationMs: 3000, segs: [{ utf8: "Hi there" }] }] });
  let asked;
  const result = await subtitles.read(doc, 60, "auto", emptyFetch, tracks, async (track) => {
    asked = track.languageCode;
    return json3;
  });
  assert.equal(asked, "en", "the original audio's track wins over a dub's");
  assert.equal(result.via, "player");
  assert.equal(result.segments[0].text, "Hi there");
  const nothing = await subtitles.read(doc, 60, "auto", emptyFetch, tracks, async () => null);
  assert.equal(nothing, null, "an empty answer is not subtitles");
});
