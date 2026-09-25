// Renders the panel from extension/panel.js in several states and interface
// languages to PNG files (.e2e/panel-*.png), for reviewing the design without
// YouTube.   node e2e/panel-preview.mjs [en|es|ru|uk ...]
import { chromium } from "playwright-core";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const executable = process.env.E2E_CHROME || path.join(os.homedir(),
  "Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing");
const scripts = ["i18n.js", "panel.js"].map((file) => fs.readFileSync(path.join(project, "extension", file), "utf8"));
const icon = "data:image/png;base64," + fs.readFileSync(path.join(project, "extension/icons/lion-48.png")).toString("base64");
const locales = process.argv.slice(2).length ? process.argv.slice(2) : ["en", "es", "ru", "uk"];
const metrics = `p.setMetrics({ ahead: 3, speed: 4.8, stops: 2.1, voiced: 41, skipped: 1,
  source: "audio-recognition", from: "de", into: "uk" });`;
const states = {
  idle: "",
  active: `p.setMode("active"); p.setStatus("status.live", {}, "live"); p.setBuffer(34);
    p.setCaption("Що це означає для Rails? Ця людина придумала майже всі функції мови.");`,
  settings: `p.setMode("idle"); open("settings");`,
  diagnostics: `p.setMode("paused"); p.setStatus("status.paused", {}, "paused"); p.setBuffer(3); ${metrics}
    p.warn({ key: "warn.skipped", params: { text: "...", reason: { key: "error.voice_empty" } } }); open("diagnostics");`,
  error: `p.setStatus({ key: "status.recognitionFailed", params: { reason: { key: "error.js_runtime_missing" } } }, {}, "error");`,
  menu: `shadow.getElementById("locale").click();`,
};
const browser = await chromium.launch({ executablePath: executable });
for (const locale of locales) {
  for (const [name, script] of Object.entries(states)) {
    const tall = ["settings", "diagnostics"].includes(name);
    const page = await browser.newPage({ viewport: { width: 380, height: tall ? 720 : 440 },
      deviceScaleFactor: 2, locale });
    await page.setContent(`<html><body style="margin:0;background:#0f0f0f"></body></html>`);
    // The extension's content scripts share one scope; so do these tags.
    for (const source of scripts) await page.addScriptTag({ content: source });
    await page.evaluate(({ icon, script }) => {
      // Closed shadow roots cannot be reached from outside: open it for the preview.
      const attach = Element.prototype.attachShadow;
      Element.prototype.attachShadow = function () { return (window.__shadow = attach.call(this, { mode: "open" })); };
      window.chrome = { runtime: { getURL: () => icon }, storage: { local: { get: async () => ({}), set() {} } } };
      const p = DubPanel.create({});
      const shadow = window.__shadow;
      const open = (id) => { shadow.getElementById(id).open = true; };
      eval(script); // one of the fixed state snippets above, nothing external

    }, { icon, script });
    await page.waitForTimeout(350);
    await page.screenshot({ path: path.join(project, ".e2e", `panel-${locale}-${name}.png`) });
    await page.close();
  }
}
await browser.close();
console.log(`ok: ${locales.join(", ")}`);
