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
  var ltBg = document.getElementById("lt-bg");
  var ltContent = document.getElementById("lt-content");

  // Current on-screen state, so we know whether an incoming "show" is a
  // fresh entrance (bar currently hidden) or an in-place slide swap
  // (bar already visible — e.g. operator clicks straight from one verse
  // to the next).
  var isVisible = false;
  var hideTimer = null;

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
      // Only the song title is shown on the projection - the slide label
      // ("Verse 1", "Chorus 2", etc.) is operator-facing only (see the
      // control UI's slide list/nav label), never rendered here.
      return (
        '<div class="slide slide-lyric">' +
        '<div class="lyric-lines">' + linesHtml + "</div>" +
        '<div class="lyric-meta">' +
        (content.songTitle ? '<span class="song-title">' + escapeHtml(content.songTitle) + "</span>" : "") +
        "</div>" +
        "</div>"
      );
    }

    if (slideType === "songtitle") {
      // Automatic intro card shown before a song's first lyric slide -
      // title + (by default) "LoveWorld Singers", since there are no other
      // singers to distinguish - see control/app.js's TITLE_CARD_SUBTITLE.
      return (
        '<div class="slide slide-songtitle">' +
        '<div class="songtitle-title">' + escapeHtml(content.title) + "</div>" +
        (content.subtitle ? '<div class="songtitle-subtitle">' + escapeHtml(content.subtitle) + "</div>" : "") +
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

  // Caches each background's real pixel aspect ratio after the first load,
  // keyed by URL, so re-showing the same background (very common — e.g.
  // stepping through verses) never re-measures it.
  var bgAspectCache = {};

  // Whether the operator has set a manual background height override (see
  // applyLayout) — when true, the real image's aspect ratio is not applied,
  // since an explicit height always wins over auto-fit. currentBgUrl tracks
  // what's actually showing so applyLayout can re-derive its aspect ratio
  // (from bgAspectCache) when switching back from manual to auto height.
  var manualBgHeight = false;
  var currentBgUrl = null;

  function applyBackground(content) {
    var filename = content && content.background;
    if (filename) {
      // Backgrounds are served statically from /backgrounds/<filename> per
      // PROTOCOL.md. Each background is a real graphic at its own designed
      // pixel size (e.g. a wide, short lower-third bar) — by default (no
      // manual override) the box is sized to match that exact shape (see
      // setBackgroundAspect) rather than assuming a fixed shape, so nothing
      // is stretched/cropped unless the operator deliberately sets one.
      var url = "/backgrounds/" + filename;
      currentBgUrl = url;
      ltBg.style.backgroundImage = "url(" + encodeURI(url) + ")";
      ltBg.classList.remove("no-bg");
      setBackgroundAspect(url);
    } else {
      // No asset configured for this slide (or none exist yet in
      // data/backgrounds/) — fall back to a plain gradient scrim so the
      // lower third always renders cleanly instead of looking broken.
      currentBgUrl = null;
      ltBg.style.backgroundImage = "";
      ltBg.classList.add("no-bg");
      ltBg.classList.remove("has-bg-aspect");
    }
  }

  function setBackgroundAspect(url) {
    var cached = bgAspectCache[url];
    if (cached) {
      ltBg.style.setProperty("--bg-aspect", cached);
      if (!manualBgHeight) ltBg.classList.add("has-bg-aspect");
      return;
    }
    var img = new Image();
    img.onload = function () {
      if (!img.naturalWidth || !img.naturalHeight) return;
      var ratio = img.naturalWidth + " / " + img.naturalHeight;
      bgAspectCache[url] = ratio;
      // Only apply if this background is still the one actually showing —
      // guards against a fast slide-to-slide switch resolving out of order.
      if (ltBg.style.backgroundImage.indexOf(encodeURI(url)) !== -1) {
        ltBg.style.setProperty("--bg-aspect", ratio);
        if (!manualBgHeight) ltBg.classList.add("has-bg-aspect");
      }
    };
    img.src = url;
  }

  // Maps the small whitelisted fontFamily keys (validated server-side too -
  // see sanitizeLayout in server/index.js) to real CSS font stacks. Kept to
  // fonts that ship with Windows so this works fully offline, no web fonts.
  var FONT_FAMILY_STACKS = {
    arial: 'Arial, "Helvetica Neue", Helvetica, sans-serif',
    serif: 'Georgia, "Times New Roman", serif',
    sans: '-apple-system, "Segoe UI", Roboto, Arial, sans-serif',
    condensed: '"Arial Narrow", "Segoe UI", sans-serif',
    rounded: 'Calibri, "Trebuchet MS", sans-serif',
  };
  var TEXT_ALIGN_JUSTIFY = { top: "flex-start", middle: "center", bottom: "flex-end" };
  var TEXT_HALIGN_ITEMS = { left: "flex-start", center: "center", right: "flex-end" };

  // Two independent layout sources: `layout` sizes/positions the shared
  // lower-third box for scripture/lyric/announcement; `titleCardLayout` does
  // the same for the automatic song-title-card slide. Only one is ever
  // "active" at a time (whichever matches the slide currently on screen) -
  // see applyActiveLayout, called on every paint() with the slideType being
  // painted, and again whenever either layout itself changes so a mid-song
  // adjustment still lands correctly on whichever one is showing.
  var currentLayout = {};
  var currentTitleCardLayout = {};

  // Applies operator-configured dimension/style overrides for whichever
  // layout applies to `slideType`. Any field left null/undefined falls back
  // to the CSS default (see style.css) - a background height of null
  // specifically means "auto-fit to the real image", handled via the
  // has-bg-aspect class above rather than a fixed --bg-height value. Font
  // family/bold/all-caps/vertical-align similarly fall back to each slide
  // type's own CSS defaults when unset, rather than forcing every slide to
  // look the same.
  function applyActiveLayout(slideType) {
    var layout = (slideType === "songtitle" ? currentTitleCardLayout : currentLayout) || {};
    var root = document.documentElement.style;

    root.setProperty("--bg-width", (typeof layout.bgWidthPct === "number" ? layout.bgWidthPct : 100) + "vw");
    root.setProperty("--text-width", (typeof layout.textWidthPct === "number" ? layout.textWidthPct : 88) + "vw");
    root.setProperty("--text-height", (typeof layout.textHeightPct === "number" ? layout.textHeightPct : 28) + "vh");

    manualBgHeight = typeof layout.bgHeightPct === "number";
    if (manualBgHeight) {
      root.setProperty("--bg-height", layout.bgHeightPct + "vh");
      ltBg.classList.remove("has-bg-aspect");
    } else {
      root.removeProperty("--bg-height");
      if (currentBgUrl && bgAspectCache[currentBgUrl]) {
        ltBg.style.setProperty("--bg-aspect", bgAspectCache[currentBgUrl]);
        ltBg.classList.add("has-bg-aspect");
      }
    }

    root.setProperty("--content-justify", TEXT_ALIGN_JUSTIFY[layout.textAlign] || TEXT_ALIGN_JUSTIFY.bottom);
    root.setProperty("--content-align-items", TEXT_HALIGN_ITEMS[layout.textHAlign] || TEXT_HALIGN_ITEMS.left);
    root.setProperty("--content-text-align", layout.textHAlign || "left");

    var fontStack = FONT_FAMILY_STACKS[layout.fontFamily];
    if (fontStack) root.setProperty("--content-font-family", fontStack);
    else root.removeProperty("--content-font-family");

    if (layout.bold) root.setProperty("--content-font-weight", "700");
    else root.removeProperty("--content-font-weight");

    root.setProperty("--content-font-style", layout.italic ? "italic" : "normal");
    root.setProperty("--content-text-transform", layout.allCaps ? "uppercase" : "none");
  }

  function applyLayout(layout) {
    currentLayout = layout || {};
    applyActiveLayout(currentSlideType);
  }

  function applyTitleCardLayout(layout) {
    currentTitleCardLayout = layout || {};
    applyActiveLayout(currentSlideType);
  }

  function paint(slideType, content) {
    ltContent.innerHTML = buildSlideHtml(slideType, content);
    applyBackground(content);
    applyActiveLayout(slideType);
  }

  // Full entrance: bar slides/fades up from nothing.
  function showEntrance(slideType, content) {
    clearTimeout(hideTimer);
    paint(slideType, content);
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

  // In-place swap: bar stays exactly where it is, content is replaced
  // directly with no fade/blink - the operator just sees the text (and
  // background, if it changed) change, nothing goes off and back on. Used
  // when a new "show" arrives while already visible, and for "update"
  // (Next/Previous stepping).
  function swapInPlace(slideType, content) {
    paint(slideType, content);
  }

  function hide() {
    clearTimeout(hideTimer);
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

  function applyTextScale(scale) {
    if (typeof scale === "number" && isFinite(scale)) {
      document.documentElement.style.setProperty("--text-scale", scale);
    }
  }

  function applyState(msg) {
    // Sent on every fresh connection so a late-joining display re-syncs.
    applyTextScale(msg.textScale);
    applyLayout(msg.layout);
    applyTitleCardLayout(msg.titleCardLayout);
    if (msg.visible && msg.current && msg.current.slideType) {
      currentSlideType = msg.current.slideType;
      showEntrance(msg.current.slideType, msg.current.content);
    } else {
      currentSlideType = msg.current && msg.current.slideType ? msg.current.slideType : currentSlideType;
      hide();
    }
  }

  // ---- Shared message handling (used by both the live WebSocket and, in
  // preview mode, postMessage from a parent /control window) -----------------

  function handleMessage(msg) {
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
      case "textScale":
        applyTextScale(msg.scale);
        break;
      case "layout":
        applyLayout(msg.layout);
        break;
      case "titleCardLayout":
        applyTitleCardLayout(msg.layout);
        break;
      default:
        console.warn("[display] unknown message type:", msg.type);
    }
  }

  // ---- Preview mode --------------------------------------------------------
  //
  // With ?preview=1, this page is embedded as an iframe inside /control (the
  // "Preview" tab) instead of being the real OBS Browser Source. It never
  // touches the shared WebSocket/live broadcast state at all - it only
  // renders whatever the parent window posts to it via postMessage, using
  // the exact same rendering code as the real live output for an accurate
  // preview (including the actual background graphic), completely isolated
  // from what's really on screen.
  var isPreview = /(?:^|[?&])preview=1(?:&|$)/.test(window.location.search);

  if (isPreview) {
    window.addEventListener("message", function (evt) {
      if (evt.source !== window.parent || evt.origin !== window.location.origin) return;
      if (!evt.data || typeof evt.data !== "object") return;
      handleMessage(evt.data);
    });
  } else {
    // ---- WebSocket connection + reconnect with backoff ---------------------

    var RECONNECT_DELAYS = [500, 1000, 2000, 4000, 8000, 10000];
    var reconnectAttempt = 0;
    var reconnectTimer = null;
    var ws = null;

    var wsUrl = function () {
      var protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      return protocol + "//" + window.location.host + "/ws";
    };

    var connect = function () {
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
        handleMessage(msg);
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
    };

    var scheduleReconnect = function () {
      clearTimeout(reconnectTimer);
      var delay = RECONNECT_DELAYS[Math.min(reconnectAttempt, RECONNECT_DELAYS.length - 1)];
      reconnectAttempt++;
      reconnectTimer = setTimeout(connect, delay);
    };

    connect();
  }
})();
