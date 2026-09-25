/* The on-page control panel. Owns markup, styling, settings persistence,
   interface language and presentation only; content.js drives it through the
   returned API and never builds user-facing text itself: it passes message
   keys, which are rendered in the current interface language and re-rendered
   when the viewer switches it. */
(function (root) {
  // `language` is the video's language, `into` the dubbing language (null:
  // follow the interface), `uiLocale` the interface language (null: browser).
  const DEFAULTS = { language: "auto", into: null, uiLocale: null, original: 20, voice: 90,
    showCaption: true, collapsed: false, hidden: false, position: { right: 20, bottom: 20 } };
  const SOURCES = ["auto", "en", "es", "de"];
  const TARGETS = ["ru", "uk"];
  const EDGE = 8;
  const TONES = ["idle", "busy", "live", "paused", "error"];

  const ICONS = {
    play: '<path d="M8 5.5v13l11-6.5z"/>',
    pause: '<path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z"/>',
    stop: '<rect x="6.5" y="6.5" width="11" height="11" rx="1.5"/>',
    minimize: '<path d="M6 12h12" stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none"/>',
    close: '<path d="M7 7l10 10M17 7L7 17" stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none"/>',
    chevron: '<path d="M8 10l4 4 4-4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"/>',
    globe: '<circle cx="12" cy="12" r="8.5" stroke="currentColor" stroke-width="1.7" fill="none"/><path d="M3.5 12h17M12 3.5c2.5 2.6 3.6 5.4 3.6 8.5s-1.1 5.9-3.6 8.5c-2.5-2.6-3.6-5.4-3.6-8.5s1.1-5.9 3.6-8.5z" stroke="currentColor" stroke-width="1.7" fill="none"/>',
    check: '<path d="M5.5 12.5l4 4 9-9" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"/>',
    copy: '<rect x="8" y="8" width="11" height="11" rx="2" stroke="currentColor" stroke-width="1.8" fill="none"/><path d="M5 15V6a1 1 0 0 1 1-1h9" stroke="currentColor" stroke-width="1.8" fill="none"/>',
  };
  const icon = (name) => `<svg viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">${ICONS[name]}</svg>`;

  const STYLE = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .root {
      --bg: #15171c; --raised: #1d2027; --line: rgba(255,255,255,.08);
      --text: #eceef2; --muted: #9aa0ab; --faint: #6b717c;
      --accent: #f5a524; --accent-ink: #1a1204;
      --live: #3ecf8e; --busy: #f5a524; --paused: #8ea2c8; --error: #ff6b6b;
      --quick: 150ms; --base: 220ms; --ease: cubic-bezier(.2,.8,.2,1);
      position: fixed; right: 20px; bottom: 20px; z-index: 2147483647;
      font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      color: var(--text);
    }
    button { font: inherit; color: inherit; border: 0; background: none; cursor: pointer; }
    button:focus-visible, input:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
    svg { width: 16px; height: 16px; display: block; }

    .fab { width: 48px; height: 48px; border-radius: 50%; padding: 0; position: relative;
      touch-action: none;
      background: var(--bg); border: 1px solid var(--line);
      box-shadow: 0 8px 24px rgba(0,0,0,.45); display: grid; place-items: center;
      transition: transform var(--quick) var(--ease); }
    .fab:hover { transform: scale(1.06); }
    .fab img { width: 30px; height: 30px; border-radius: 8px; }
    .fab .dot { position: absolute; right: 2px; bottom: 2px; border: 2px solid var(--bg); }

    /* Never taller than the window: the header (and with it dragging and the
       close button) stays reachable, and the sections scroll inside instead. */
    .card { position: relative; width: 312px; background: var(--bg); border: 1px solid var(--line); border-radius: 16px;
      box-shadow: 0 16px 40px rgba(0,0,0,.5); overflow: hidden;
      display: flex; flex-direction: column; max-height: calc(100vh - 16px);
      transform-origin: bottom right;
      transition: opacity var(--base) var(--ease), transform var(--base) var(--ease); }
    .root[data-collapsed="true"] .card { display: none; }
    .root[data-collapsed="false"] .fab { display: none; }
    .card.entering { opacity: 0; transform: scale(.96) translateY(6px); }
    .root[data-anchor="top"] .card { transform-origin: top right; }
    .root[data-anchor="top"] .card.entering { transform: scale(.96) translateY(-6px); }
    .card > header, .card > .body { flex: none; }
    .card > .more { min-height: 0; overflow-y: auto; overscroll-behavior: contain; }

    header { display: flex; align-items: center; gap: 10px; padding: 12px 10px 12px 14px;
      cursor: grab; user-select: none; touch-action: none; }
    .root.dragging, .root.dragging * { cursor: grabbing !important; user-select: none; }
    .root.dragging .fab { transform: none; }
    header img { width: 24px; height: 24px; border-radius: 6px; }
    header h1 { flex: 1; margin: 0; font-size: 14px; font-weight: 600; letter-spacing: .01em; }
    .icon-btn { width: 28px; height: 28px; border-radius: 8px; display: grid; place-items: center;
      color: var(--muted); transition: background var(--quick), color var(--quick); }
    .icon-btn:hover, .icon-btn[aria-expanded="true"] { background: var(--raised); color: var(--text); }

    /* Outside the card, which clips its rounded corners and would clip the menu. */
    .menu { position: absolute; top: 46px; right: 10px; z-index: 2; min-width: 190px; padding: 4px;
      background: var(--raised); border: 1px solid var(--line); border-radius: 10px;
      box-shadow: 0 12px 28px rgba(0,0,0,.5);
      transform-origin: top right; transition: opacity var(--quick) var(--ease), transform var(--quick) var(--ease); }
    .menu[hidden] { display: none; }
    .menu.entering { opacity: 0; transform: scale(.96) translateY(-4px); }
    .menu button { width: 100%; height: 32px; padding: 0 8px 0 10px; border-radius: 7px;
      display: flex; align-items: center; justify-content: space-between; gap: 12px; text-align: left; }
    .menu button:hover, .menu button:focus-visible { background: #2d323c; outline: none; }
    .menu button svg { visibility: hidden; color: var(--accent); }
    .menu button[aria-checked="true"] svg { visibility: visible; }
    .menu .hint { color: var(--faint); font-size: 12px; }
    .menu hr { border: 0; border-top: 1px solid var(--line); margin: 4px 2px; }

    .body { padding: 0 14px 14px; display: grid; grid-template-columns: minmax(0, 1fr); gap: 12px; }

    .primary { display: flex; gap: 8px; }
    .btn { height: 38px; border-radius: 10px; padding: 0 14px; display: inline-flex; align-items: center;
      justify-content: center; gap: 8px; font-weight: 600;
      transition: background var(--quick), filter var(--quick), opacity var(--quick); }
    .btn.main { flex: 1; background: var(--accent); color: var(--accent-ink); }
    .btn.main:hover { filter: brightness(1.08); }
    .btn.ghost { background: var(--raised); border: 1px solid var(--line); }
    .primary .btn.ghost { flex: 1; }
    .btn.ghost:hover { background: #262a33; }
    .btn[hidden] { display: none; }

    .caption { margin: 0; font-size: 15px; line-height: 1.45; color: var(--text);
      display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
    .caption:empty, .caption[hidden] { display: none; }

    .status { display: flex; align-items: center; gap: 8px; color: var(--muted); min-height: 18px; }
    .status span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    [data-tone="error"] .status { align-items: flex-start; }
    [data-tone="error"] .status span { white-space: normal; overflow-wrap: anywhere; }
    [data-tone="error"] .status .dot { margin-top: 5px; }
    .dot { width: 8px; height: 8px; border-radius: 50%; flex: none; background: var(--faint); }
    [data-tone="busy"] .dot { background: var(--busy); animation: pulse 1.2s ease-in-out infinite; }
    [data-tone="live"] .dot { background: var(--live); }
    [data-tone="paused"] .dot { background: var(--paused); }
    [data-tone="error"] .dot { background: var(--error); }
    [data-tone="error"] .status { color: #ffb4b4; }
    @keyframes pulse { 50% { opacity: .35; } }

    .buffer { display: grid; gap: 6px; }
    .buffer[hidden] { display: none; }
    .buffer .label { display: flex; justify-content: space-between; color: var(--faint); font-size: 11px; }
    .bar { height: 4px; border-radius: 2px; background: var(--raised); overflow: hidden; }
    .bar i { display: block; height: 100%; width: 0; background: var(--live);
      transition: width 600ms linear; }

    details { border-top: 1px solid var(--line); padding: 0 14px; }
    summary { list-style: none; display: flex; align-items: center; justify-content: space-between;
      padding: 12px 0; cursor: pointer; color: var(--muted); font-weight: 500; }
    summary::-webkit-details-marker { display: none; }
    summary svg { transition: transform var(--quick) var(--ease); }
    details[open] summary svg { transform: rotate(180deg); }
    summary .badge { margin-left: auto; margin-right: 8px; width: 7px; height: 7px; border-radius: 50%;
      background: var(--error); }
    summary .badge[hidden] { display: none; }
    .section { display: grid; gap: 12px; padding-bottom: 14px; }

    .field { display: grid; gap: 6px; }
    .field > .name { color: var(--faint); font-size: 11px; text-transform: uppercase; letter-spacing: .06em; }
    .segmented { display: grid; grid-template-columns: repeat(var(--count, 3), 1fr); padding: 3px; gap: 3px;
      background: var(--raised); border: 1px solid var(--line); border-radius: 10px; }
    .segmented button { height: 28px; border-radius: 7px; color: var(--muted); font-weight: 500;
      transition: background var(--quick), color var(--quick); }
    .segmented button[aria-pressed="true"] { background: #2d323c; color: var(--text); }
    .segmented button:disabled { cursor: default; opacity: .5; }

    .slider { display: grid; grid-template-columns: 1fr 40px; align-items: center; gap: 10px; }
    .slider output { color: var(--muted); text-align: right; font-variant-numeric: tabular-nums; }
    input[type=range] { -webkit-appearance: none; appearance: none; width: 100%; height: 4px;
      border-radius: 2px; margin: 0;
      background: linear-gradient(var(--accent), var(--accent)) 0 / var(--fill, 50%) 100% no-repeat, var(--raised); }
    input[type=range]::-webkit-slider-thumb { -webkit-appearance: none; width: 14px; height: 14px;
      border-radius: 50%; background: var(--text); border: 0; box-shadow: 0 1px 4px rgba(0,0,0,.5); }

    .switch { display: flex; align-items: center; justify-content: space-between; cursor: pointer; }
    .switch input { position: absolute; opacity: 0; pointer-events: none; }
    .switch .track { width: 32px; height: 18px; border-radius: 9px; background: var(--raised);
      border: 1px solid var(--line); position: relative; transition: background var(--quick); }
    .switch .track::after { content: ""; position: absolute; top: 2px; left: 2px; width: 12px; height: 12px;
      border-radius: 50%; background: var(--muted); transition: transform var(--quick) var(--ease), background var(--quick); }
    .switch input:checked + .track { background: var(--accent); }
    .switch input:checked + .track::after { transform: translateX(14px); background: var(--accent-ink); }
    .switch input:focus-visible + .track { outline: 2px solid var(--accent); outline-offset: 2px; }

    dl { display: grid; grid-template-columns: auto 1fr; gap: 6px 12px; margin: 0; }
    dt { color: var(--faint); }
    dd { margin: 0; text-align: right; font-variant-numeric: tabular-nums; }
    .warning { margin: 0; padding: 8px 10px; border-radius: 8px; background: rgba(255,107,107,.08);
      color: #ffc9c9; font-size: 12px; overflow-wrap: anywhere; }
    .warning:empty { display: none; }
    .btn.small { height: 30px; font-weight: 500; font-size: 12px; }

    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after { transition-duration: 1ms !important; animation-duration: 1ms !important; }
    }
  `;

  function create({ onStart, onStop, onPause, onSettingsChange, onCopyLog }) {
    const host = document.createElement("div");
    host.id = "local-youtube-dub-ui";
    document.documentElement.appendChild(host);
    const shadow = host.attachShadow({ mode: "closed" });
    const lion = chrome.runtime.getURL("icons/lion-48.png");
    const { ENDONYMS, LOCALES } = DubI18n;
    const segment = (value, label) => `<button data-value="${value}"${label ? ` data-i18n="${label}"` : ""}>${label ? "" : ENDONYMS[value]}</button>`;
    // Static markup only; every visible string is filled in by applyLocale().
    shadow.innerHTML = `<style>${STYLE}</style>
      <div class="root" data-collapsed="false" data-tone="idle">
        <button class="fab" id="fab" title="YouTube Translate" data-i18n-aria="panel.open">
          <img src="${lion}" alt=""><span class="dot"></span></button>
        <div class="menu" id="locale-menu" role="menu" hidden>
            <button role="menuitemradio" data-locale=""><span><span data-i18n="locale.auto"></span>
              <span class="hint" id="browser-locale"></span></span>${icon("check")}</button>
            <hr>
            ${LOCALES.map((locale) => `<button role="menuitemradio" data-locale="${locale}" lang="${locale}">
              <span>${ENDONYMS[locale]}</span>${icon("check")}</button>`).join("")}
          </div>
        <section class="card" role="dialog" aria-label="YouTube Translate">
          <header data-i18n-title="panel.drag">
            <img src="${lion}" alt="">
            <h1>YouTube Translate</h1>
            <button class="icon-btn" id="locale" aria-haspopup="menu" aria-expanded="false"
              data-i18n-title="panel.locale" data-i18n-aria="panel.locale">${icon("globe")}</button>
            <button class="icon-btn" id="minimize" data-i18n-title="panel.minimize"
              data-i18n-aria="panel.minimize">${icon("minimize")}</button>
            <button class="icon-btn" id="close" data-i18n-title="panel.closeHint"
              data-i18n-aria="panel.close">${icon("close")}</button>
          </header>
          <div class="body">
            <div class="primary">
              <button class="btn main" id="start">${icon("play")}<span data-i18n="action.start"></span></button>
              <button class="btn ghost" id="pause" hidden>${icon("pause")}<span></span></button>
              <button class="btn ghost" id="stop" hidden data-i18n-title="action.stopHint">${icon("stop")}<span data-i18n="action.stop"></span></button>
            </div>
            <p class="caption" id="caption" aria-live="polite"></p>
            <div class="status" id="status-row"><i class="dot"></i><span id="status"></span></div>
            <div class="buffer" id="buffer" hidden>
              <div class="label"><span data-i18n="buffer.label"></span><span id="buffer-value"></span></div>
              <div class="bar"><i id="buffer-bar"></i></div>
            </div>
          </div>
          <div class="more">
            <details id="settings">
              <summary><span data-i18n="section.settings"></span>${icon("chevron")}</summary>
              <div class="section">
                <div class="field"><span class="name" data-i18n="field.source"></span>
                  <div class="segmented" id="language" role="group" data-i18n-aria="field.source" style="--count: 4">
                    ${segment("auto", "source.auto")}${SOURCES.slice(1).map((code) => segment(code)).join("")}</div></div>
                <div class="field"><span class="name" data-i18n="field.into"></span>
                  <div class="segmented" id="into" role="group" data-i18n-aria="field.into" style="--count: 2">
                    ${TARGETS.map((code) => segment(code)).join("")}</div></div>
                <label class="field"><span class="name" data-i18n="field.original"></span>
                  <span class="slider"><input id="original" type="range" min="0" max="100" step="5">
                  <output id="original-value"></output></span></label>
                <label class="field"><span class="name" data-i18n="field.voice"></span>
                  <span class="slider"><input id="voice" type="range" min="0" max="100" step="5">
                  <output id="voice-value"></output></span></label>
                <label class="switch"><span data-i18n="field.caption"></span>
                  <input type="checkbox" id="show-caption"><span class="track"></span></label>
              </div>
            </details>
            <details id="diagnostics">
              <summary><span data-i18n="section.diagnostics"></span><span class="badge" id="diag-badge" hidden></span>${icon("chevron")}</summary>
              <div class="section">
                <dl id="metrics"></dl>
                <p class="warning" id="warning"></p>
                <button class="btn ghost small" id="copy-log">${icon("copy")}<span data-i18n="log.copy"></span></button>
              </div>
            </details>
          </div>
        </section>
      </div>`;

    const $ = (id) => shadow.getElementById(id);
    const rootEl = shadow.querySelector(".root");
    const card = shadow.querySelector(".card");
    let settings = { ...DEFAULTS };
    let locked = false;
    let mode = "idle";
    let t = DubI18n.translator(DubI18n.browserLocale());
    // What is on screen, kept as message keys so a language switch re-renders it.
    let shown = { status: { key: "status.ready", tone: "idle" }, warning: null, metrics: null, buffer: 0 };

    const locale = () => settings.uiLocale || DubI18n.browserLocale();
    const into = () => settings.into || (locale() === "uk" ? "uk" : "ru");

    // A message is {key, params, fallback}; params may be messages themselves.
    function render(message) {
      if (!message) return "";
      if (typeof message === "string") return message;
      const params = {};
      for (const [name, value] of Object.entries(message.params || {})) {
        params[name] = value && typeof value === "object" ? render(value) : value;
      }
      return t(message.key, params, message.fallback);
    }

    function applyLocale() {
      t = DubI18n.translator(locale());
      host.lang = locale();
      for (const node of shadow.querySelectorAll("[data-i18n]")) node.textContent = t(node.dataset.i18n);
      for (const node of shadow.querySelectorAll("[data-i18n-title]")) node.title = t(node.dataset.i18nTitle);
      for (const node of shadow.querySelectorAll("[data-i18n-aria]")) node.setAttribute("aria-label", t(node.dataset.i18nAria));
      $("browser-locale").textContent = `· ${DubI18n.ENDONYMS[DubI18n.browserLocale()]}`;
      for (const item of $("locale-menu").querySelectorAll("button")) {
        item.setAttribute("aria-checked", String((item.dataset.locale || null) === settings.uiLocale));
      }
      $("pause").querySelector("span").textContent = t(mode === "paused" ? "action.resume" : "action.pause");
      paintStatus();
      paintWarning();
      paintMetrics();
      paintBuffer();
    }

    function paintStatus() {
      const text = render(shown.status);
      $("status").textContent = text;
      $("status-row").title = text;
      rootEl.dataset.tone = TONES.includes(shown.status.tone) ? shown.status.tone : "idle";
      host.dataset.status = text;
      host.dataset.statusKey = shown.status.key || "";
      host.dataset.tone = rootEl.dataset.tone;
    }

    function paintWarning() {
      const text = render(shown.warning);
      $("warning").textContent = text;
      $("diag-badge").hidden = !text;
      host.dataset.warning = text;
    }

    function paintBuffer() {
      const seconds = Math.max(0, Math.round(shown.buffer));
      $("buffer-value").textContent = t("unit.seconds", { value: seconds });
      $("buffer-bar").style.width = `${Math.min(100, seconds / 60 * 100)}%`;
      $("buffer-bar").style.background = seconds < 5 ? "var(--busy)" : "var(--live)";
    }

    function paintMetrics() {
      const data = shown.metrics;
      if (!data) { $("metrics").replaceChildren(); return; }
      const seconds = (value) => t("unit.seconds", { value });
      const rows = [
        ["metric.ahead", seconds(data.ahead)],
        ["metric.speed", data.speed ? `${data.speed.toFixed(1)}×` : "—"],
        ["metric.stops", `${data.stops.toFixed(1)} %`],
        ["metric.voiced", String(data.voiced)],
        ["metric.skipped", String(data.skipped)],
        ["metric.source", t(`kind.${data.source}`, {}, data.source)],
        ["metric.language", `${data.from === "auto" ? t("source.auto") : data.from.toUpperCase()} → ${data.into.toUpperCase()}`],
      ].map(([key, value]) => [t(key), value]);
      $("metrics").replaceChildren(...rows.flatMap(([name, value]) => {
        const dt = document.createElement("dt");
        const dd = document.createElement("dd");
        dt.textContent = name;
        dd.textContent = value;
        return [dt, dd];
      }));
      host.dataset.metrics = rows.map(([name, value]) => `${name}: ${value}`).join(" · ");
    }

    function save() {
      try { chrome.storage?.local.set({ dubSettings: settings }); } catch (_) { /* storage unavailable */ }
    }

    function renderSettings() {
      for (const button of $("language").querySelectorAll("button")) {
        button.setAttribute("aria-pressed", String(button.dataset.value === settings.language));
        button.disabled = locked;
      }
      for (const button of $("into").querySelectorAll("button")) {
        button.setAttribute("aria-pressed", String(button.dataset.value === into()));
        button.disabled = locked;
      }
      for (const name of ["original", "voice"]) {
        $(name).value = settings[name];
        $(name).style.setProperty("--fill", `${settings[name]}%`);
        $(`${name}-value`).textContent = `${settings[name]}%`;
      }
      $("show-caption").checked = settings.showCaption;
      $("caption").hidden = !settings.showCaption;
      rootEl.dataset.collapsed = String(settings.collapsed);
      host.style.display = settings.hidden || !visibleOnPage ? "none" : "";
      applyLocale();
      place();
    }

    // Changes made before the stored settings arrive must survive their arrival.
    let touched = {};
    function update(patch) {
      touched = { ...touched, ...patch };
      settings = { ...settings, ...patch };
      save();
      renderSettings();
      onSettingsChange?.(settings, patch);
    }

    function expand() {
      card.classList.add("entering");
      update({ collapsed: false });
      card.offsetWidth; // start the transition from the entering state
      card.classList.remove("entering");
    }

    // The panel is pinned to the window edge it is nearer to: in the lower half
    // by its bottom, in the upper half by its top. It then grows away from that
    // edge when a section opens, instead of pushing its header off-screen, and
    // the collapsed button sits where the card's corner was.
    function anchored(right, top, height) {
      return top + height / 2 < innerHeight / 2
        ? { right, top }
        : { right, bottom: innerHeight - top - height };
    }

    // Applies a position, clamped so the whole panel stays inside the window.
    function place(position = settings.position) {
      const box = rootEl.getBoundingClientRect();
      const clamp = (value, size, room) => Math.min(Math.max(EDGE, value), Math.max(EDGE, room - size - EDGE));
      const right = clamp(position.right, box.width, innerWidth);
      rootEl.style.right = `${right}px`;
      if ("top" in position) {
        const top = clamp(position.top, box.height, innerHeight);
        rootEl.style.top = `${top}px`;
        rootEl.style.bottom = "auto";
        rootEl.dataset.anchor = "top";
        return { right, top };
      }
      const bottom = clamp(position.bottom, box.height, innerHeight);
      rootEl.style.bottom = `${bottom}px`;
      rootEl.style.top = "auto";
      rootEl.dataset.anchor = "bottom";
      return { right, bottom };
    }

    // Returns true from the click that ends a drag, so the button does not also
    // treat it as a press.
    function draggable(handle) {
      let drag = null;
      let moved = false;
      handle.addEventListener("pointerdown", (event) => {
        if (event.button !== 0 || (handle !== $("fab") && event.target.closest("button"))) return;
        const box = rootEl.getBoundingClientRect();
        drag = { x: event.clientX, y: event.clientY, right: innerWidth - box.right, top: box.top,
          height: box.height };
        moved = false;
        handle.setPointerCapture(event.pointerId);
      });
      handle.addEventListener("pointermove", (event) => {
        if (!drag) return;
        const dx = event.clientX - drag.x;
        const dy = event.clientY - drag.y;
        if (!moved && Math.hypot(dx, dy) < 4) return;
        moved = true;
        rootEl.classList.add("dragging");
        drag.last = place(anchored(drag.right - dx, drag.top + dy, drag.height));
      });
      const end = () => {
        if (!drag) return;
        rootEl.classList.remove("dragging");
        if (moved && drag.last) update({ position: drag.last });
        drag = null;
      };
      handle.addEventListener("pointerup", end);
      handle.addEventListener("pointercancel", end);
      return () => {
        const wasDrag = moved;
        moved = false;
        return wasDrag;
      };
    }

    // The interface-language menu: opened from the globe, closed by a choice,
    // Escape, or a click anywhere else; arrow keys move between items.
    const menu = $("locale-menu");
    const items = () => [...menu.querySelectorAll("button")];
    function openMenu() {
      menu.hidden = false;
      menu.classList.add("entering");
      menu.offsetWidth; // start the transition from the entering state
      menu.classList.remove("entering");
      $("locale").setAttribute("aria-expanded", "true");
      (items().find((item) => item.getAttribute("aria-checked") === "true") || items()[0]).focus();
    }
    function closeMenu(returnFocus = false) {
      if (menu.hidden) return;
      menu.hidden = true;
      $("locale").setAttribute("aria-expanded", "false");
      if (returnFocus) $("locale").focus();
    }
    $("locale").addEventListener("click", () => (menu.hidden ? openMenu() : closeMenu()));
    menu.addEventListener("click", (event) => {
      const item = event.target.closest("button");
      if (!item) return;
      update({ uiLocale: item.dataset.locale || null });
      closeMenu(true);
    });
    menu.addEventListener("keydown", (event) => {
      const list = items();
      const at = list.indexOf(shadow.activeElement);
      if (event.key === "Escape") { event.preventDefault(); closeMenu(true); }
      if (event.key === "ArrowDown") { event.preventDefault(); list[(at + 1) % list.length].focus(); }
      if (event.key === "ArrowUp") { event.preventDefault(); list[(at - 1 + list.length) % list.length].focus(); }
    });
    shadow.addEventListener("pointerdown", (event) => {
      if (!event.composedPath().some((node) => node === menu || node === $("locale"))) closeMenu();
    });
    document.addEventListener("pointerdown", (event) => {
      if (!event.composedPath().includes(host)) closeMenu();
    });

    let visibleOnPage = true;
    const fabDragged = draggable($("fab"));
    draggable(shadow.querySelector("header"));
    shadow.querySelector("header").addEventListener("dblclick", (event) => {
      if (!event.target.closest("button")) update({ position: { ...DEFAULTS.position } });
    });
    addEventListener("resize", () => place());
    // Opening a section, collapsing, a longer status or another interface
    // language all change the size; each change is re-clamped at once.
    new ResizeObserver(() => place()).observe(rootEl);
    addEventListener("languagechange", () => { if (!settings.uiLocale) renderSettings(); });
    $("fab").addEventListener("click", () => { if (!fabDragged()) expand(); });
    $("minimize").addEventListener("click", () => update({ collapsed: true }));
    $("close").addEventListener("click", () => { onStop?.(); update({ hidden: true }); });
    $("start").addEventListener("click", () => onStart?.());
    $("stop").addEventListener("click", () => onStop?.());
    $("pause").addEventListener("click", () => onPause?.());
    $("language").addEventListener("click", (event) => {
      const value = event.target.closest("button")?.dataset.value;
      if (value && !locked) update({ language: value });
    });
    $("into").addEventListener("click", (event) => {
      const value = event.target.closest("button")?.dataset.value;
      if (value && !locked) update({ into: value });
    });
    for (const name of ["original", "voice"]) {
      $(name).addEventListener("input", () => update({ [name]: Number($(name).value) }));
    }
    $("show-caption").addEventListener("change", () => update({ showCaption: $("show-caption").checked }));
    $("copy-log").addEventListener("click", async () => {
      const label = $("copy-log").querySelector("span");
      try {
        await navigator.clipboard.writeText(onCopyLog?.() || "");
        label.textContent = t("log.copied");
      } catch (_) {
        label.textContent = t("log.failed");
      }
      setTimeout(() => { label.textContent = t("log.copy"); }, 1500);
    });

    try {
      chrome.storage?.local.get("dubSettings").then((stored) => {
        settings = { ...DEFAULTS, ...(stored?.dubSettings || {}), ...touched };
        renderSettings();
        // Positions saved before edge anchoring are all bottom-based.
        const box = rootEl.getBoundingClientRect();
        const position = anchored(innerWidth - box.right, box.top, box.height);
        if (box.height && "top" in position && !("top" in settings.position)) update({ position });
      }).catch(() => renderSettings());
    } catch (_) { renderSettings(); }
    renderSettings();

    return {
      host,
      get settings() { return settings; },
      /** The dubbing language in effect: chosen, or following the interface. */
      get into() { return into(); },
      toggleHidden() {
        update({ hidden: !settings.hidden, collapsed: false });
      },
      setVisibleOnPage(visible) {
        visibleOnPage = visible;
        renderSettings();
      },
      // idle | preparing | active | paused
      setMode(next) {
        mode = next;
        const running = mode !== "idle";
        $("start").hidden = running;
        $("pause").hidden = !running || mode === "preparing";
        $("stop").hidden = !running;
        $("pause").querySelector("svg").outerHTML = icon(mode === "paused" ? "play" : "pause");
        $("buffer").hidden = mode === "idle" || mode === "preparing";
        locked = running;
        if (!running) this.setCaption("");
        renderSettings();
      },
      /** A message key with params, and a tone: idle | busy | live | paused | error. */
      setStatus(key, params, tone = "idle") {
        shown.status = typeof key === "object" ? { ...key, tone } : { key, params, tone };
        paintStatus();
      },
      setCaption(text) {
        $("caption").textContent = text;
        host.dataset.caption = text;
      },
      setBuffer(seconds) {
        shown.buffer = seconds;
        paintBuffer();
      },
      /** Raw numbers and codes; labels and units follow the interface language. */
      setMetrics(data) {
        shown.metrics = data;
        paintMetrics();
      },
      warn(message) {
        shown.warning = message || null;
        paintWarning();
      },
    };
  }

  root.DubPanel = { create, DEFAULTS };
})(globalThis);
