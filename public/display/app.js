/* ==========================================================================
   Church Presenter — /display (OBS Browser Source)

   Connects to the shared WebSocket endpoint per PROTOCOL.md, renders the
   current slide (scripture / lyric / announcement) as a lower-third graphic,
   and stays in sync with the server across reconnects.

   No build step, no dependencies — plain DOM + WebSocket API only.
   ========================================================================== */

(function () {
  "use strict";

  var lowerThird = document.getElementById("lower-third");
  var ltInner = document.querySelector(".lt-inner");
  var ltBg = document.getElementById("lt-bg");
  var ltContent = document.getElementById("lt-content");

  // Current on-screen state, so we know whether an incoming "show" is a
  // fresh entrance (bar currently hidden) or an in-place slide swap
  // (bar already visible — e.g. operator clicks straight from one verse
  // to the next).
  var isVisible = false;
  var hideTimer = null;
  var swapTimer = null;

  var SWAP_MS = 200; // in-place content/background crossfade duration
  var HIDE_MS = 420; // must be >= the CSS .lower-third transition duration

  // ---- Rendering ---------------------------------------------------------

  function escapeHtml(str) {
    return String(str == null ? "" : str).replace(/[&<>"']/g, function (ch) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch];
    });
  }

  function buildSlideHtml(slideType, content) {
    content = content || {};
    if (slideType === "scripture") {
      return (
        '<div class="slide slide-scripture">' +
        '<div class="scripture-text">' + escapeHtml(content.text) + "</div>" +
        '<div class="scripture-meta">' +
        '<span class="scripture-ref">' + escapeHtml(content.reference) + "</span>" +
        (content.translation
          ? '<span class="scripture-translation">' + escapeHtml(content.translation) + "</span>"
          : "") +
        "</div>" +
        "</div>"
      );
    }

    if (slideType === "lyric") {
      var lines = Array.isArray(content.lines) ? content.lines : [];
      var linesHtml = lines.map(function (l) { return "<div>" + escapeHtml(l) + "</div>"; }).join("");
      return (
        '<div class="slide slide-lyric">' +
        '<div class="lyric-lines">' + linesHtml + "</div>" +
        '<div class="lyric-meta">' +
        (content.songTitle ? '<span class="song-title">' + escapeHtml(content.songTitle) + "</span>" : "") +
        (content.slideLabel ? '<span class="slide-label">' + escapeHtml(content.slideLabel) + "</span>" : "") +
        "</div>" +
        "</div>"
      );
    }

    if (slideType === "announcement") {
      return (
        '<div class="slide slide-announcement">' +
        '<div class="announcement-title">' + escapeHtml(content.title) + "</div>" +
        (content.body ? '<div class="announcement-body">' + escapeHtml(content.body) + "</div>" : "") +
        "</div>"
      );
    }

    // Unknown slideType: fail soft rather than showing nothing/breaking.
    console.warn("[display] unknown slideType, rendering generically:", slideType, content);
    var fallbackText = content.text || content.body || JSON.stringify(content);
    return (
      '<div class="slide slide-generic">' +
      '<div class="announcement-title">' + escapeHtml(content.title || slideType || "") + "</div>" +
      '<div class="announcement-body">' + escapeHtml(fallbackText) + "</div>" +
      "</div>"
    );
  }

  function applyBackground(content) {
    var filename = content && content.background;
    if (filename) {
      // Backgrounds are served statically from /backgrounds/<filename> per
      // PROTOCOL.md. Treated as a pre-shaped 16:9 lower-third graphic and
      // stretched to fill the bar edge-to-edge.
      ltBg.style.backgroundImage = "url(" + encodeURI("/backgrounds/" + filename) + ")";
      ltBg.classList.remove("no-bg");
    } else {
      // No asset configured for this slide (or none exist yet in
      // data/backgrounds/) — fall back to a plain gradient scrim so the
      // lower third always renders cleanly instead of looking broken.
      ltBg.style.backgroundImage = "";
      ltBg.classList.add("no-bg");
    }
  }

  function paint(slideType, content) {
    ltContent.innerHTML = buildSlideHtml(slideType, content);
    applyBackground(content);
  }

  // Full entrance: bar slides/fades up from nothing.
  function showEntrance(slideType, content) {
    clearTimeout(hideTimer);
    clearTimeout(swapTimer);
    paint(slideType, content);
    ltInner.classList.remove("is-swapping");
    // Ensure the "hidden" starting styles have been applied before we flip
    // to visible, so the transition actually runs.
    lowerThird.classList.remove("is-visible");
    // force reflow, then trigger the transition on the next frame
    void lowerThird.offsetHeight;
    requestAnimationFrame(function () {
      lowerThird.classList.add("is-visible");
    });
    isVisible = true;
  }

  // In-place swap: bar stays put, background+text crossfade to new content.
  // Used when a new "show" arrives while already visible, and for "update".
  function swapInPlace(slideType, content) {
    clearTimeout(swapTimer);
    ltInner.classList.add("is-swapping");
    swapTimer = setTimeout(function () {
      paint(slideType, content);
      ltInner.classList.remove("is-swapping");
    }, SWAP_MS);
  }

  function hide() {
    clearTimeout(hideTimer);
    clearTimeout(swapTimer);
    lowerThird.classList.remove("is-visible");
    isVisible = false;
    // Clear content only after the exit transition finishes, so nothing
    // flashes mid-animation, and so no stale box/shadow lingers once the
    // bar has faded away.
    hideTimer = setTimeout(function () {
      ltContent.innerHTML = "";
      ltBg.style.backgroundImage = "";
      ltBg.classList.add("no-bg");
    }, HIDE_MS);
  }

  // ---- Slide/state application -------------------------------------------

  var currentSlideType = null;

  function applyShow(slideType, content) {
    currentSlideType = slideType;
    if (isVisible) {
      swapInPlace(slideType, content);
    } else {
      showEntrance(slideType, content);
    }
  }

  function applyUpdate(content) {
    if (!currentSlideType) {
      // No prior slideType context (e.g. update arrived before any show) —
      // nothing sensible to render; ignore per protocol (server only sends
      // update when state.current already exists).
      return;
    }
    // Hide is a safety-critical control: once the operator has hidden the
    // bar, an "update" (e.g. from Prev/Next verse stepping) must never pop
    // it back onto the live stream/projector on its own. Only apply the new
    // content in-place while already visible; while hidden, just remember
    // it for whenever the operator explicitly shows something again.
    if (isVisible) {
      swapInPlace(currentSlideType, content);
    }
  }

  function applyHide() {
    hide();
  }

  function applyState(msg) {
    // Sent on every fresh connection so a late-joining display re-syncs.
    if (msg.visible && msg.current && msg.current.slideType) {
      currentSlideType = msg.current.slideType;
      showEntrance(msg.current.slideType, msg.current.content);
    } else {
      currentSlideType = msg.current && msg.current.slideType ? msg.current.slideType : currentSlideType;
      hide();
    }
  }

  // ---- WebSocket connection + reconnect with backoff ---------------------

  var RECONNECT_DELAYS = [500, 1000, 2000, 4000, 8000, 10000];
  var reconnectAttempt = 0;
  var reconnectTimer = null;
  var ws = null;

  function wsUrl() {
    var protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    return protocol + "//" + window.location.host + "/ws";
  }

  function connect() {
    clearTimeout(reconnectTimer);
    try {
      ws = new WebSocket(wsUrl());
    } catch (err) {
      scheduleReconnect();
      return;
    }

    ws.addEventListener("open", function () {
      reconnectAttempt = 0;
    });

    ws.addEventListener("message", function (evt) {
      var msg;
      try {
        msg = JSON.parse(evt.data);
      } catch (err) {
        console.warn("[display] malformed message from server:", evt.data);
        return;
      }
      switch (msg.type) {
        case "state":
          applyState(msg);
          break;
        case "show":
          if (msg.slideType && msg.content) applyShow(msg.slideType, msg.content);
          break;
        case "update":
          if (msg.content) applyUpdate(msg.content);
          break;
        case "hide":
          applyHide();
          break;
        default:
          console.warn("[display] unknown message type:", msg.type);
      }
    });

    ws.addEventListener("close", function () {
      scheduleReconnect();
    });

    ws.addEventListener("error", function () {
      // "close" fires right after "error" for WebSocket failures, so the
      // reconnect scheduling there is sufficient — just avoid throwing.
      try {
        ws.close();
      } catch (err) {
        /* no-op */
      }
    });
  }

  function scheduleReconnect() {
    clearTimeout(reconnectTimer);
    var delay = RECONNECT_DELAYS[Math.min(reconnectAttempt, RECONNECT_DELAYS.length - 1)];
    reconnectAttempt++;
    reconnectTimer = setTimeout(connect, delay);
  }

  connect();
})();
