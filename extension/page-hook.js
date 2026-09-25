/* Runs in the page's own world from document_start. YouTube only answers a
   subtitle request that carries a proof-of-origin token (pot), which the
   player adds and the extension cannot: a plain fetch of a track's baseUrl
   returns 200 with an empty body. So the player's own subtitle responses are
   kept here, per video and language, for the extension to read
   (background.js, load-caption-track). Nothing is sent anywhere. */
(() => {
  if (window.__ytTranslateTimedtext) return;
  const store = new Map();
  window.__ytTranslateTimedtext = store;

  function keep(url, body) {
    try {
      const params = new URL(url, location.href).searchParams;
      // A translated track (tlang) is YouTube's machine translation, not what
      // was said; only json3 carries the timing the extension needs.
      if (!body || params.get("fmt") !== "json3" || params.has("tlang")) return;
      store.set(`${params.get("v")}|${params.get("lang")}`, body);
    } catch (_) { /* not a URL this hook understands */ }
  }

  const open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    const address = String(url);
    if (address.includes("/api/timedtext")) {
      this.addEventListener("load", () => keep(address, this.responseText));
    }
    return open.apply(this, arguments);
  };

  const originalFetch = window.fetch;
  window.fetch = async function (input) {
    const response = await originalFetch.apply(this, arguments);
    const url = typeof input === "string" ? input : input?.url || "";
    if (url.includes("/api/timedtext")) response.clone().text().then((body) => keep(url, body), () => {});
    return response;
  };
})();
