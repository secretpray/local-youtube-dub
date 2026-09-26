// End-to-end check in a throwaway Chrome for Testing profile: loads the
// unpacked extension, registers the native host for that profile only, opens
// a YouTube video, turns translation on and waits for dubbed phrases.
//
//   node e2e/run.mjs VIDEO_ID [START_SECONDS] [PHRASES] [--seek=SECONDS] [--into=ru|uk] [--from=auto|en|es|de]
import { chromium } from "playwright-core";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [videoId = "cMX-u9ltG5Q", startArg = "0", phrasesArg = "6"] =
  process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
const flag = (name) => process.argv.find((arg) => arg.startsWith(`--${name}=`))?.split("=")[1];
const seekArg = flag("seek");
const wanted = Number(phrasesArg);
const extension = path.join(project, "extension");
// A snap browser only reaches its own directories: E2E_PROFILE moves the profile
// there (e.g. ~/snap/chromium/common/e2e-profile).
const profile = process.env.E2E_PROFILE || path.join(project, ".e2e", "profile");
const manifest = JSON.parse(fs.readFileSync(path.join(extension, "manifest.json"), "utf8"));
const der = Buffer.from(manifest.key, "base64");
const { createHash } = await import("node:crypto");
const extensionId = [...createHash("sha256").update(der).digest("hex").slice(0, 32)]
  .map((c) => String.fromCharCode(97 + parseInt(c, 16))).join("");

// Playwright's own Chromium for this OS (npx playwright-core install chromium),
// unless E2E_CHROME names another build that still accepts --load-extension.
// On Windows ARM64 Playwright only has an x64 Chromium, which runs emulated;
// the native Edge (E2E_CHROME=...\\msedge.exe) is closer to what people use.
const executable = process.env.E2E_CHROME || chromium.executablePath();

// Chromium reads per-user native messaging manifests from <user-data-dir>
// on macOS and Linux. On Windows it reads only the registry, under the
// browser's own key; that registration is swapped in for the run and the
// previous one put back afterwards.
const windows = process.platform === "win32";
const manifestPath = path.join(profile, "NativeMessagingHosts", "org.local_youtube_dub.host.json");
fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
fs.writeFileSync(manifestPath,
  JSON.stringify({
    name: "org.local_youtube_dub.host",
    description: "YouTube Translate (e2e)",
    path: path.join(project, "bin", windows ? "local-youtube-dub-host.exe" : "local-youtube-dub-host"),
    type: "stdio",
    allowed_origins: [`chrome-extension://${extensionId}/`],
  }, null, 2));
const browserKey = /msedge\.exe$/i.test(executable) ? "Microsoft\\Edge"
  : /brave\.exe$/i.test(executable) ? "BraveSoftware\\Brave-Browser"
  : /Google\\Chrome\\/i.test(executable) ? "Google\\Chrome" : "Chromium";
const registryKey = `HKCU\\Software\\${browserKey}\\NativeMessagingHosts\\org.local_youtube_dub.host`;
let previousRegistration = null;
if (windows) {
  try {
    const answer = execFileSync("reg", ["query", registryKey, "/ve"], { encoding: "utf8" });
    previousRegistration = answer.match(/REG_SZ\s+(.+)/)?.[1].trim() ?? null;
  } catch { /* no registration before this run */ }
  execFileSync("reg", ["add", registryKey, "/ve", "/d", manifestPath, "/f"], { stdio: "ignore" });
}
function restoreRegistration() {
  if (!windows) return;
  if (previousRegistration) {
    execFileSync("reg", ["add", registryKey, "/ve", "/d", previousRegistration, "/f"], { stdio: "ignore" });
  } else {
    execFileSync("reg", ["delete", registryKey, "/f"], { stdio: "ignore" });
  }
}
process.on("exit", restoreRegistration);
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => process.exit(130));

const context = await chromium.launchPersistentContext(profile, {
  executablePath: executable,
  headless: false,
  // The real window size: a forced viewport can be taller than a small screen
  // (a VM's display), and the panel is pinned to a page edge nobody can see.
  viewport: null,
  ignoreDefaultArgs: ["--mute-audio"],
  args: [
    `--disable-extensions-except=${extension}`,
    `--load-extension=${extension}`,
    "--autoplay-policy=no-user-gesture-required",
    "--window-position=40,40",
    // A Linux desktop on Wayland has no X server for Chromium's default backend.
    ...(process.platform === "linux" && process.env.WAYLAND_DISPLAY ? ["--ozone-platform=wayland"] : []),
  ],
});
// Panel settings live in extension storage; set them before the page reads them.
const serviceWorker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
await serviceWorker.evaluate((settings) => chrome.storage.local.set({ dubSettings: settings }),
  { into: flag("into") || "ru", language: flag("from") || "auto" });
const page = context.pages()[0] || await context.newPage();
const log = (...args) => console.log(new Date().toISOString().slice(11, 19), ...args);
page.on("console", (message) => {
  if (message.type() === "error") log("console:", message.text().slice(0, 200));
});

await page.goto(`https://www.youtube.com/watch?v=${videoId}&t=${startArg}s`, { waitUntil: "domcontentloaded" });
for (const label of ["Reject all", "Отклонить все", "Reject the use of cookies and other data for the purposes described"]) {
  const button = page.getByRole("button", { name: label }).first();
  if (await button.isVisible({ timeout: 1500 }).catch(() => false)) {
    await button.click();
    log("consent: declined non-essential cookies");
    break;
  }
}
await page.waitForSelector("video.html5-main-video", { timeout: 60_000 });
await page.waitForFunction(() => document.querySelector("video")?.readyState >= 1, null, { timeout: 60_000 });
await page.evaluate((start) => {
  const video = document.querySelector("video.html5-main-video");
  video.currentTime = Number(start);
  video.play().catch(() => {});
}, startArg);
await page.waitForTimeout(3000);
const hostHandle = await page.waitForSelector("#local-youtube-dub-ui", { state: "attached", timeout: 20_000 });

// The panel is in a closed shadow root: start through the extension instead.
async function pressStart() {
  const worker = context.serviceWorkers().find((w) => w.url().includes(extensionId))
    || await context.waitForEvent("serviceworker");
  await worker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ url: "https://www.youtube.com/watch*" });
    await chrome.tabs.sendMessage(tab.id, { type: "start-dub" });
  });
}
await page.screenshot({ path: path.join(project, ".e2e", "before.png") });
await pressStart();
log("pressed start");

const started = Date.now();
let last = "";
let seeked = false;
let firstPlayAt = null;
while (Date.now() - started < 15 * 60_000) {
  const state = await page.evaluate(() => {
    const host = document.getElementById("local-youtube-dub-ui");
    const video = document.querySelector("video.html5-main-video");
    const { log, ...data } = host.dataset; return { ...data, time: video.currentTime.toFixed(1), paused: video.paused,
      volume: video.volume.toFixed(2), rate: video.playbackRate };
  });
  const line = JSON.stringify(state);
  if (line !== last) { log(line); last = line; }
  const played = Number(state.played || 0);
  if (played && firstPlayAt == null) {
    firstPlayAt = Date.now();
    log(`first phrase after ${((firstPlayAt - started) / 1000).toFixed(1)} s`);
  }
  if (state.tone === "error" || /^error\./.test(state.statusKey || "")) {
    log("FAILED:", state.status);
    break;
  }
  if (seekArg && !seeked && played >= 2) {
    seeked = true;
    log(`seeking to ${seekArg}`);
    await page.evaluate((to) => { document.querySelector("video.html5-main-video").currentTime = Number(to); }, seekArg);
  }
  if (played >= wanted && (!seekArg || seeked && played >= wanted + 2)) {
    log(`OK: ${played} phrases dubbed`);
    break;
  }
  await page.waitForTimeout(1000);
}
const journal = await page.evaluate(() => document.getElementById("local-youtube-dub-ui")?.dataset.log).catch(() => "");
if (journal) console.log(`--- session log ---\n${journal}`);
await page.screenshot({ path: path.join(project, ".e2e", "after.png") }).catch(() => {});
await hostHandle.dispose();
await context.close();
