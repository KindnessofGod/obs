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
  var ltSubtitle = document.getElementById("lt-subtitle");

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
      // Automatic intro card shown before a song's first lyric slide - the
      // title itself. The "LoveWorld Singers" byline is a fully separate
      // box (.lt-subtitle, see buildSubtitleHtml below) so the two can be
      // sized/positioned/colored independently of each other.
      return (
        '<div class="slide slide-songtitle">' +
        '<div class="songtitle-title">' + escapeHtml(content.title) + "</div>" +
        "</div>"
      );
    }

    if (slideType === "devotional") {
      // Full-screen daily devotional (Rhapsody of Realities, Teevo, etc.) -
      // unlike every other slide type this isn't a lower-third bar, it's
      // meant to cover the whole screen with its text centered on both axes
      // by default (see DEVOTIONAL_LAYOUT_DEFAULTS in control/app.js), while
      // still using the exact same resizable/draggable box machinery as
      // every other slide type. content.title is intentionally never
      // rendered here - it's operator-facing only (the live/staged banner
      // and slide list in control/app.js), not part of the projection.
      var devoLines = Array.isArray(content.lines) ? content.lines : [];
      var devoLinesHtml = devoLines.map(function (l) { return "<div>" + escapeHtml(l) + "</div>"; }).join("");
      return (
        '<div class="slide slide-devotional">' +
        '<div class="devotional-lines">' + devoLinesHtml + "</div>" +
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

  // The song title card's "LoveWorld Singers" byline - its own independent
  // box (.lt-subtitle), separate from buildSlideHtml/.lt-content so it can
  // be moved, sized, and colored on its own. Empty for every other slide
  // type, and for a title card with no subtitle text at all.
  function buildSubtitleHtml(slideType, content) {
    content = content || {};
    if (slideType !== "songtitle" || !content.subtitle) return "";
    return '<div class="subtitle-text">' + escapeHtml(content.subtitle) + "</div>";
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
  var currentLyricLayout = {};
  var currentTitleCardLayout = {};
  var currentDevotionalLayout = {};

  // Which layout object governs a given slideType's bg/text box - shared by
  // applyActiveLayout and the preview drag-to-position handler below.
  function layoutForSlideType(slideType) {
    if (slideType === "lyric") return { layout: currentLyricLayout, key: "lyricLayout" };
    if (slideType === "songtitle") return { layout: currentTitleCardLayout, key: "titleCardLayout" };
    if (slideType === "devotional") return { layout: currentDevotionalLayout, key: "devotionalLayout" };
    return { layout: currentLayout, key: "layout" };
  }

  // Applies operator-configured dimension/style overrides for whichever
  // layout applies to `slideType`. Any field left null/undefined falls back
  // to the CSS default (see style.css) - a background height of null
  // specifically means "auto-fit to the real image", handled via the
  // has-bg-aspect class above rather than a fixed --bg-height value. Font
  // family/bold/all-caps/vertical-align similarly fall back to each slide
  // type's own CSS defaults when unset, rather than forcing every slide to
  // look the same.
  function applyActiveLayout(slideType) {
    var layout = layoutForSlideType(slideType).layout || {};
    var root = document.documentElement.style;

    root.setProperty("--bg-width", (typeof layout.bgWidthPct === "number" ? layout.bgWidthPct : 100) + "vw");
    root.setProperty("--text-width", (typeof layout.textWidthPct === "number" ? layout.textWidthPct : 88) + "vw");
    root.setProperty("--text-height", (typeof layout.textHeightPct === "number" ? layout.textHeightPct : 28) + "vh");

    // Free horizontal/vertical drag away from the normal bottom-left anchor.
    // Y is negated so a positive offset (as shown in the control UI) moves
    // the box up the screen, matching how "more" reads intuitively there.
    root.setProperty("--bg-offset-x", (typeof layout.bgOffsetXPct === "number" ? layout.bgOffsetXPct : 0) + "vw");
    root.setProperty("--bg-offset-y", (typeof layout.bgOffsetYPct === "number" ? -layout.bgOffsetYPct : 0) + "vh");
    root.setProperty("--text-offset-x", (typeof layout.textOffsetXPct === "number" ? layout.textOffsetXPct : 0) + "vw");
    root.setProperty("--text-offset-y", (typeof layout.textOffsetYPct === "number" ? -layout.textOffsetYPct : 0) + "vh");

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

    if (layout.color) root.setProperty("--content-color", layout.color);
    else root.removeProperty("--content-color");

    // Independent of --text-scale (the operator's global A-/A+ control,
    // applied on top of this) - a per-box multiplier so each text group's
    // size can be tuned on its own without touching its box width.
    root.setProperty("--content-font-size-scale", (typeof layout.fontSizePct === "number" ? layout.fontSizePct : 100) / 100);
  }

  // The song title card's subtitle ("LoveWorld Singers") box - independent
  // of applyActiveLayout above since, unlike --bg-*/--content-*, it's never
  // swapped between slide types: only the title card ever populates
  // .lt-subtitle, so it always just applies straight from its own layout.
  var currentTitleCardSubtitleLayout = {};

  function applySubtitleLayout() {
    var layout = currentTitleCardSubtitleLayout || {};
    var root = document.documentElement.style;

    root.setProperty("--subtitle-width", (typeof layout.textWidthPct === "number" ? layout.textWidthPct : 55) + "vw");
    root.setProperty("--subtitle-height", (typeof layout.textHeightPct === "number" ? layout.textHeightPct : 10) + "vh");
    root.setProperty("--subtitle-offset-x", (typeof layout.textOffsetXPct === "number" ? layout.textOffsetXPct : 0) + "vw");
    root.setProperty("--subtitle-offset-y", (typeof layout.textOffsetYPct === "number" ? -layout.textOffsetYPct : 0) + "vh");

    root.setProperty("--subtitle-justify", TEXT_ALIGN_JUSTIFY[layout.textAlign] || TEXT_ALIGN_JUSTIFY.bottom);
    root.setProperty("--subtitle-align-items", TEXT_HALIGN_ITEMS[layout.textHAlign] || TEXT_HALIGN_ITEMS.center);
    root.setProperty("--subtitle-text-align", layout.textHAlign || "center");

    var fontStack = FONT_FAMILY_STACKS[layout.fontFamily];
    if (fontStack) root.setProperty("--subtitle-font-family", fontStack);
    else root.removeProperty("--subtitle-font-family");

    if (layout.bold) root.setProperty("--subtitle-font-weight", "700");
    else root.removeProperty("--subtitle-font-weight");

    root.setProperty("--subtitle-font-style", layout.italic ? "italic" : "normal");
    root.setProperty("--subtitle-text-transform", layout.allCaps ? "uppercase" : "none");

    if (layout.color) root.setProperty("--subtitle-color", layout.color);
    else root.removeProperty("--subtitle-color");

    root.setProperty("--subtitle-font-size-scale", (typeof layout.fontSizePct === "number" ? layout.fontSizePct : 100) / 100);
  }

  function applyLayout(layout) {
    currentLayout = layout || {};
    applyActiveLayout(currentSlideType);
  }

  function applyTitleCardLayout(layout) {
    currentTitleCardLayout = layout || {};
    applyActiveLayout(currentSlideType);
  }

  function applyLyricLayout(layout) {
    currentLyricLayout = layout || {};
    applyActiveLayout(currentSlideType);
  }

  function applyDevotionalLayout(layout) {
    currentDevotionalLayout = layout || {};
    applyActiveLayout(currentSlideType);
  }

  function applyTitleCardSubtitleLayout(layout) {
    currentTitleCardSubtitleLayout = layout || {};
    applySubtitleLayout();
  }

  function paint(slideType, content) {
    ltContent.innerHTML = buildSlideHtml(slideType, content);
    ltSubtitle.innerHTML = buildSubtitleHtml(slideType, content);
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
      ltSubtitle.innerHTML = "";
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
    applyLyricLayout(msg.lyricLayout);
    applyTitleCardLayout(msg.titleCardLayout);
    applyTitleCardSubtitleLayout(msg.titleCardSubtitleLayout);
    applyDevotionalLayout(msg.devotionalLayout);
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
      case "lyricLayout":
        applyLyricLayout(msg.layout);
        break;
      case "titleCardLayout":
        applyTitleCardLayout(msg.layout);
        break;
      case "titleCardSubtitleLayout":
        applyTitleCardSubtitleLayout(msg.layout);
        break;
      case "devotionalLayout":
        applyDevotionalLayout(msg.layout);
        break;
      default:
        console.warn("[display] unknown message type:", msg.type);
    }
  }

  // ---- Preview-mode drag-to-position ---------------------------------------
  //
  // Lets the operator grab the background/text/byline boxes directly in the
  // Preview tab and drag them, instead of only nudging percentages - the
  // real display stays non-interactive (pointer-events: none on #stage), so
  // this only ever activates inside the ?preview=1 iframe. Dragging updates
  // the same bgOffsetXPct/textOffsetXPct etc. fields the arrow-key pads use
  // (see control/app.js), just via a different input.
  function initPreviewDragging() {
    document.body.classList.add("is-preview");

    // Maps which box was grabbed + which slide type is showing to the exact
    // layout object/field pair that owns its position, mirroring the same
    // swap applyActiveLayout does for bg/text (see currentSlideType above).
    function targetFor(boxKind) {
      if (boxKind === "subtitle") {
        return { layoutKey: "titleCardSubtitleLayout", layout: currentTitleCardSubtitleLayout, xField: "textOffsetXPct", yField: "textOffsetYPct" };
      }
      var active = layoutForSlideType(currentSlideType);
      var layout = active.layout;
      var layoutKey = active.key;
      if (boxKind === "bg") return { layoutKey: layoutKey, layout: layout, xField: "bgOffsetXPct", yField: "bgOffsetYPct" };
      return { layoutKey: layoutKey, layout: layout, xField: "textOffsetXPct", yField: "textOffsetYPct" };
    }

    function clampOffset(n) {
      return Math.min(100, Math.max(-100, n));
    }

    function makeDraggable(el, boxKind) {
      var dragging = null; // { target, startClientX, startClientY, startX, startY }
      var commitScheduled = false;

      function scheduleCommit() {
        if (commitScheduled) return;
        commitScheduled = true;
        requestAnimationFrame(function () {
          commitScheduled = false;
          if (dragging) commit();
        });
      }

      function commit() {
        var t = dragging.target;
        window.parent.postMessage(
          {
            type: "previewDrag",
            layoutKey: t.layoutKey,
            xField: t.xField,
            yField: t.yField,
            offsetX: t.layout[t.xField] || 0,
            offsetY: t.layout[t.yField] || 0,
          },
          window.location.origin
        );
      }

      el.addEventListener("pointerdown", function (e) {
        if (e.button !== 0) return;
        var target = targetFor(boxKind);
        dragging = {
          target: target,
          startClientX: e.clientX,
          startClientY: e.clientY,
          startX: target.layout[target.xField] || 0,
          startY: target.layout[target.yField] || 0,
        };
        el.classList.add("pv-dragging");
        el.setPointerCapture(e.pointerId);
        e.preventDefault();
      });

      el.addEventListener("pointermove", function (e) {
        if (!dragging) return;
        var vw = document.documentElement.clientWidth || 1;
        var vh = document.documentElement.clientHeight || 1;
        var deltaXPct = ((e.clientX - dragging.startClientX) / vw) * 100;
        // Negated: dragging down moves the box down, which is a *negative*
        // offset in our "positive = up" convention (see applyActiveLayout).
        var deltaYPct = -((e.clientY - dragging.startClientY) / vh) * 100;
        var t = dragging.target;
        t.layout[t.xField] = clampOffset(dragging.startX + deltaXPct);
        t.layout[t.yField] = clampOffset(dragging.startY + deltaYPct);
        if (t.layoutKey === "titleCardSubtitleLayout") applySubtitleLayout();
        else applyActiveLayout(currentSlideType);
        scheduleCommit();
      });

      function endDrag(e) {
        if (!dragging) return;
        try {
          el.releasePointerCapture(e.pointerId);
        } catch (err) {
          /* no-op */
        }
        el.classList.remove("pv-dragging");
        commit();
        dragging = null;
      }

      el.addEventListener("pointerup", endDrag);
      el.addEventListener("pointercancel", endDrag);
    }

    makeDraggable(ltBg, "bg");
    makeDraggable(ltContent, "text");
    makeDraggable(ltSubtitle, "subtitle");
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
    initPreviewDragging();
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
