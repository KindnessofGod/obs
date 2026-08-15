(() => {
  "use strict";

  // Distinguishes our own action echoes (the server broadcasts every show/
  // update back to every client, including the sender) from a genuinely
  // different window's action. Rapid stepping (e.g. holding an arrow key)
  // can send a new action before the echo of the PREVIOUS one comes back,
  // so an echo can arrive out of order - without this, a stale echo of an
  // action we've already moved past locally would be indistinguishable
  // from a newer change and would stomp our local state backward.
  const CLIENT_ID = Math.random().toString(36).slice(2);
  // Per-type counter of our own sends, tagged onto outgoing content as
  // `_seq` so an echo can be recognized as older than what we've since
  // moved on to locally (see isStaleOwnEcho).
  const sendSeq = { scripture: 0, lyric: 0, announcement: 0 };

  // ============================================================
  // WebSocket connection
  // ============================================================

  let ws = null;
  let wsBackoff = 1000;
  const WS_BACKOFF_MAX = 8000;
  const PENDING_QUEUE_MAX = 20; // defensive cap, not a realistic operator click rate

  const wsStatusEl = document.getElementById("wsStatus");
  let wsState = "connecting";

  // Messages queued because the socket wasn't open at send() time - flushed the
  // moment it reconnects. Without this, clicking Show/Hide/Next during a
  // momentary disconnect (which happens routinely - OBS browser source
  // reloads, brief network hiccups) silently did nothing: no error, no retry,
  // nothing on screen, and no indication to the operator that anything failed.
  let pendingQueue = [];

  function setWsStatus(state) {
    wsState = state;
    renderWsStatus();
  }

  function renderWsStatus() {
    wsStatusEl.className = "ws-status ws-" + wsState;
    let label = wsState === "connected" ? "connected" : wsState === "connecting" ? "connecting…" : "reconnecting…";
    if (pendingQueue.length) label += ` (${pendingQueue.length} pending)`;
    wsStatusEl.querySelector(".label").textContent = label;
  }

  function connectWs() {
    setWsStatus(ws ? "connecting" : "connecting");
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    ws = new WebSocket(`${proto}//${window.location.host}/ws`);

    ws.addEventListener("open", () => {
      wsBackoff = 1000;
      setWsStatus("connected");
      flushPendingQueue();
      // Push this operator's saved text-size/layout preferences so the
      // display (and any other open control window) picks them up even if
      // the server was restarted since they were last set.
      send({ type: "textScale", scale: textScale });
      send({ type: "layout", layout });
    });

    ws.addEventListener("close", () => {
      setWsStatus("disconnected");
      scheduleReconnect();
    });

    ws.addEventListener("error", () => {
      setWsStatus("disconnected");
    });

    ws.addEventListener("message", (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      handleServerMessage(msg);
    });
  }

  function scheduleReconnect() {
    setTimeout(connectWs, wsBackoff);
    wsBackoff = Math.min(wsBackoff * 1.6, WS_BACKOFF_MAX);
  }

  function send(obj) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(obj));
    } else {
      pendingQueue.push(obj);
      if (pendingQueue.length > PENDING_QUEUE_MAX) pendingQueue.shift();
      renderWsStatus();
    }
  }

  function flushPendingQueue() {
    if (!pendingQueue.length) return;
    const queued = pendingQueue;
    pendingQueue = [];
    renderWsStatus();
    queued.forEach((obj) => send(obj));
  }

  connectWs();

  // ============================================================
  // Live banner + server -> client state sync
  // ============================================================

  const liveBannerEl = document.getElementById("liveBanner");
  let liveSlideType = null; // tracks the slideType of whatever is currently live, for `update` messages

  function renderLiveBanner(visible, current) {
    if (!visible || !current) {
      liveBannerEl.className = "live-banner live-empty";
      liveBannerEl.textContent = "Nothing showing";
      return;
    }
    liveBannerEl.className = "live-banner";
    const { slideType, content } = current;
    liveSlideType = slideType;
    let text = "";
    if (slideType === "scripture") text = `${content.reference} (${(content.translation || "").toUpperCase()})`;
    else if (slideType === "lyric") text = `${content.songTitle} — ${content.slideLabel}`;
    else if (slideType === "announcement") text = content.title;
    liveBannerEl.innerHTML = `<span class="live-kind">${slideType}</span>${escapeHtml(text)}`;
  }

  function handleServerMessage(msg) {
    if (msg.type === "state") {
      renderLiveBanner(msg.visible, msg.current);
      if (msg.visible && msg.current) reconcileLiveState(msg.current);
      if (typeof msg.textScale === "number") syncTextScale(msg.textScale);
      if (msg.layout && typeof msg.layout === "object") syncLayout(msg.layout);
    } else if (msg.type === "textScale") {
      if (typeof msg.scale === "number") syncTextScale(msg.scale);
    } else if (msg.type === "layout") {
      if (msg.layout && typeof msg.layout === "object") syncLayout(msg.layout);
    } else if (msg.type === "show") {
      renderLiveBanner(true, { slideType: msg.slideType, content: msg.content });
      reconcileLiveState({ slideType: msg.slideType, content: msg.content });
    } else if (msg.type === "update") {
      // content updated in place; slideType assumed unchanged (server only allows
      // `update` on an existing `current`, so liveSlideType is already set)
      renderLiveBanner(true, { slideType: liveSlideType, content: msg.content });
      reconcileLiveState({ slideType: liveSlideType, content: msg.content });
    } else if (msg.type === "hide") {
      renderLiveBanner(false, null);
    }
  }

  // Best-effort: when a slide becomes live (from our own action, another control
  // window, or a page reload's initial `state`), keep the Prev/Next context in sync
  // so navigation buttons work no matter who set the current slide.
  // True if `content` is an out-of-order echo of one of OUR OWN earlier
  // sends for `type` - i.e. we've since sent something newer locally (its
  // `_seq` is behind sendSeq[type]) - as opposed to a genuinely new change
  // from another window, which always gets a different `_origin`.
  function isStaleOwnEcho(content, type) {
    return !!content && content._origin === CLIENT_ID && typeof content._seq === "number" && content._seq < sendSeq[type];
  }

  function reconcileLiveState(current) {
    if (current.slideType === "scripture") {
      if (isStaleOwnEcho(current.content, "scripture")) {
        // Rapid arrow-key stepping can outrun the WS round trip: we've
        // already moved on to a newer verse locally, so an echo of an older
        // one of our own sends arriving late must be ignored - otherwise it
        // stomps the control tab's label/state back to where we used to be
        // (the display itself is unaffected since it has no such reconciliation,
        // it just always shows whatever it's told most recently).
        currentScriptureIsLive = true;
        return;
      }
      // If this is just our own "show"/"update" echoing back (the server
      // broadcasts to every client, including the sender), currentScripture
      // already correctly tracks the full parts array - re-deriving it from
      // content.text here would be wrong, since content.text is only the
      // CURRENT PART's (possibly truncated) text, not the original full
      // verse, so re-splitting it can't recover how many parts there really are.
      if (isLocallyTrackedScripture(current.content)) {
        currentScriptureIsLive = true;
        return;
      }
      const parsed = parseReference(current.content.reference);
      if (parsed) {
        // Best-effort reconstruction for a verse driven live by another
        // window: content.text is only the live part, so re-splitting it
        // can under-count the parts - not perfect, but Prev/Next still
        // works correctly for the verse-to-verse case either way. The
        // sender's own partIndex (not derived from the - now suffix-free -
        // reference string) tells us which of those re-split parts to land on.
        const parts = splitTextIntoParts(current.content.text);
        const partIndex =
          typeof current.content.partIndex === "number" ? Math.max(0, Math.min(parts.length - 1, current.content.partIndex)) : 0;
        currentScripture = { translation: current.content.translation, ...parsed, parts, partIndex };
        currentScriptureIsLive = true;
        renderScriptureNav(current.content);
      }
    } else if (current.slideType === "lyric") {
      if (isStaleOwnEcho(current.content, "lyric")) {
        currentLyricIsLive = true;
        return;
      }
      if (isLocallyTrackedLyric(current.content)) {
        currentLyricIsLive = true; // already reflects our own action, skip refetch
        return;
      }
      restoreLyricNavContext(current.content);
    }
  }

  // True if `content` (from a "show"/"update" echo) is exactly what
  // currentScripture already has staged/live - i.e. this is our own action
  // reflecting back, not a change driven by another window.
  function isLocallyTrackedScripture(content) {
    if (!currentScripture || !currentScripture.parts) return false;
    const expected = scriptureContentForPart(currentScripture, currentScripture.parts, currentScripture.partIndex);
    return expected.reference === content.reference && expected.translation === content.translation && expected.text === content.text;
  }

  function isLocallyTrackedLyric(content) {
    if (!currentSong || currentSlideIndex < 0 || !currentSlideParts) return false;
    const slide = currentSong.slides[currentSlideIndex];
    if (!slide || currentSong.title !== content.songTitle) return false;
    if (stripPartSuffix(content.slideLabel) !== slide.label) return false;
    const expectedLines = currentSlideParts[currentSlidePartIndex];
    return JSON.stringify(expectedLines) === JSON.stringify(content.lines);
  }

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str == null ? "" : String(str);
    return div.innerHTML;
  }

  // Scrolls the currently-highlighted result/slide row into view as the
  // operator steps through verses/slides, so what's actually on screen
  // never scrolls out of sight and needs a manual scroll to find. A plain
  // scrollIntoView isn't enough here: the results list sits right below a
  // `position: sticky` header (search box, nav controls, etc.) within the
  // same scrolling panel, so it could tuck an item's top edge exactly under
  // that header, hiding it behind it. scroll-margin-top (read by
  // scrollIntoView's alignment) reserves that header's actual current
  // height so the item lands fully visible below it instead.
  function scrollActiveIntoView(item) {
    if (!item) return;
    const list = item.parentElement;
    const header = list && list.previousElementSibling;
    const headerHeight = header && header.classList.contains("scripture-sticky-header") ? header.getBoundingClientRect().height : 0;
    item.style.scrollMarginTop = headerHeight ? `${headerHeight}px` : "";
    item.scrollIntoView({ block: "nearest" });
  }

  // ============================================================
  // Backgrounds (per slide-type, remembered separately)
  // ============================================================

  let availableBackgrounds = [];
  let selectedBackgrounds = { scripture: null, lyric: null, announcement: null };
  let lastContent = { scripture: null, lyric: null, announcement: null };

  const bgSelectEls = {
    scripture: document.getElementById("scriptureBgSelect"),
    lyric: document.getElementById("lyricBgSelect"),
    announcement: document.getElementById("announcementBgSelect"),
  };

  async function loadBackgrounds() {
    try {
      const res = await fetch("/api/config");
      const config = await res.json();
      availableBackgrounds = Array.isArray(config.backgrounds) ? config.backgrounds : [];
    } catch {
      availableBackgrounds = [];
    }

    let saved = null;
    try {
      saved = JSON.parse(localStorage.getItem("obs-control:backgrounds") || "null");
    } catch {
      saved = null;
    }
    selectedBackgrounds = { scripture: null, lyric: null, announcement: null, ...(saved || {}) };

    // Nothing chosen yet but exactly one background exists (the common case,
    // one custom lower-third graphic) — auto-select it so it works immediately.
    Object.keys(selectedBackgrounds).forEach((type) => {
      if (!selectedBackgrounds[type] || !availableBackgrounds.includes(selectedBackgrounds[type])) {
        selectedBackgrounds[type] = availableBackgrounds.length === 1 ? availableBackgrounds[0] : null;
      }
    });

    renderBackgroundPickers();
  }

  function renderBackgroundPickers() {
    Object.entries(bgSelectEls).forEach(([type, select]) => {
      select.innerHTML = "";
      const noneOpt = document.createElement("option");
      noneOpt.value = "";
      noneOpt.textContent = availableBackgrounds.length ? "Default / none" : "No backgrounds found";
      select.appendChild(noneOpt);
      availableBackgrounds.forEach((filename) => {
        const opt = document.createElement("option");
        opt.value = filename;
        opt.textContent = filename;
        select.appendChild(opt);
      });
      select.value = selectedBackgrounds[type] || "";
      select.onchange = () => setBackground(type, select.value);
    });
  }

  function setBackground(type, filename) {
    selectedBackgrounds[type] = filename || null;
    localStorage.setItem("obs-control:backgrounds", JSON.stringify(selectedBackgrounds));
    // If this slide type is live right now, re-apply immediately so the
    // operator sees the new background without having to re-show the content.
    if (liveSlideType === type && lastContent[type]) {
      sendUpdate(type, lastContent[type]);
    } else if (staged && staged.slideType === type) {
      pushPreview();
    }
  }

  function withBackground(type, content) {
    const bg = selectedBackgrounds[type];
    return bg ? { ...content, background: bg } : content;
  }

  // Tags outgoing content with our client id + a per-type sequence number
  // (see isStaleOwnEcho) without mutating `full`/`lastContent[type]` -
  // `full` can be the exact same object as `content` when no background is
  // set (withBackground returns it unchanged), so this always builds a
  // fresh object rather than assigning onto `full` directly.
  function taggedForWire(type, full) {
    if (!(type in sendSeq)) return full;
    return { ...full, _seq: ++sendSeq[type], _origin: CLIENT_ID };
  }

  function sendShow(type, content) {
    lastContent[type] = content;
    const full = withBackground(type, content);
    send({ type: "show", slideType: type, content: taggedForWire(type, full) });
    renderLiveBanner(true, { slideType: type, content: full });
  }

  function sendUpdate(type, content) {
    lastContent[type] = content;
    const full = withBackground(type, content);
    send({ type: "update", content: taggedForWire(type, full) });
    renderLiveBanner(true, { slideType: type, content: full });
  }

  loadBackgrounds();

  // ============================================================
  // Staging + preview (select first, confirm what it looks like, then
  // explicitly put it on screen — nothing here touches the live broadcast
  // until "Display Live" is clicked)
  // ============================================================

  const stagedBannerEl = document.getElementById("stagedBanner");
  const stagedTextEl = stagedBannerEl.querySelector(".staged-text");
  const displayLiveBtn = document.getElementById("displayLiveBtn");
  const previewFrame = document.getElementById("previewFrame");

  let staged = null; // { slideType, content } | null — content is unmerged (no background yet)

  function renderStagedBanner() {
    if (!staged) {
      stagedBannerEl.className = "staged-banner staged-empty";
      stagedTextEl.textContent = "Nothing staged";
      displayLiveBtn.disabled = true;
      return;
    }
    stagedBannerEl.className = "staged-banner";
    const { slideType, content } = staged;
    let text = "";
    if (slideType === "scripture") text = `${content.reference} (${(content.translation || "").toUpperCase()})`;
    else if (slideType === "lyric") text = `${content.songTitle} — ${content.slideLabel}`;
    else if (slideType === "announcement") text = content.title;
    stagedTextEl.innerHTML = `<span class="live-kind">${slideType}</span>${escapeHtml(text)}`;
    displayLiveBtn.disabled = false;
  }

  function postToPreview(msg) {
    if (!previewFrame.contentWindow) return;
    previewFrame.contentWindow.postMessage(msg, window.location.origin);
  }

  function pushPreview() {
    if (!staged) {
      postToPreview({ type: "hide" });
      return;
    }
    postToPreview({ type: "show", slideType: staged.slideType, content: withBackground(staged.slideType, staged.content) });
  }

  // The preview iframe's own script only starts listening for postMessage
  // once its document has loaded - a message posted before that is simply
  // lost (not queued), so re-push everything (content, text size, layout)
  // once it's actually ready, not just the staged content.
  previewFrame.addEventListener("load", () => {
    pushPreview();
    postToPreview({ type: "textScale", scale: textScale });
    postToPreview({ type: "layout", layout });
  });

  function stage(slideType, content) {
    staged = { slideType, content };
    renderStagedBanner();
    pushPreview();
  }

  // Stages `content` as usual, unless `autoLive` is on - then it skips
  // staging entirely and puts it straight on screen (used by scripture's
  // "Auto display" toggle so reading through a passage doesn't require a
  // "Display Live" click after every single verse).
  function stageOrGoLive(slideType, content, autoLive) {
    if (autoLive) {
      sendShow(slideType, content);
      return true;
    }
    stage(slideType, content);
    return false;
  }

  function clearStaged() {
    staged = null;
    renderStagedBanner();
    pushPreview();
  }

  displayLiveBtn.addEventListener("click", () => {
    if (!staged) return;
    sendShow(staged.slideType, staged.content);
    if (staged.slideType === "scripture") currentScriptureIsLive = true;
    if (staged.slideType === "lyric") currentLyricIsLive = true;
    clearStaged();
  });

  // ============================================================
  // Layout: independent background-box and text-box dimensions. Background
  // size and text size are deliberately separate controls (per operator
  // request) so e.g. a bigger background graphic doesn't force bigger text,
  // or vice versa.
  // ============================================================

  const LAYOUT_DEFAULTS = {
    bgWidthPct: 100,
    bgHeightPct: null,
    textWidthPct: 88,
    textHeightPct: 28,
    textAlign: "bottom",
    textHAlign: "left",
    fontFamily: "default",
    bold: false,
    allCaps: false,
  };

  const bgWidthRange = document.getElementById("bgWidthRange");
  const bgWidthValueEl = document.getElementById("bgWidthValue");
  const bgHeightAutoCheckbox = document.getElementById("bgHeightAutoCheckbox");
  const bgHeightRange = document.getElementById("bgHeightRange");
  const bgHeightValueEl = document.getElementById("bgHeightValue");
  const textWidthRange = document.getElementById("textWidthRange");
  const textWidthValueEl = document.getElementById("textWidthValue");
  const textHeightRange = document.getElementById("textHeightRange");
  const textHeightValueEl = document.getElementById("textHeightValue");
  const textAlignSelect = document.getElementById("textAlignSelect");
  const textHAlignSelect = document.getElementById("textHAlignSelect");
  const fontFamilySelect = document.getElementById("fontFamilySelect");
  const boldCheckbox = document.getElementById("boldCheckbox");
  const allCapsCheckbox = document.getElementById("allCapsCheckbox");
  const layoutResetBtn = document.getElementById("layoutResetBtn");

  let layout = { ...LAYOUT_DEFAULTS };
  {
    let saved = null;
    try {
      saved = JSON.parse(localStorage.getItem("obs-control:layout") || "null");
    } catch {
      saved = null;
    }
    if (saved && typeof saved === "object") layout = { ...LAYOUT_DEFAULTS, ...saved };
  }

  function renderLayoutControls() {
    bgWidthRange.value = layout.bgWidthPct;
    bgWidthValueEl.textContent = layout.bgWidthPct + "%";

    const autoHeight = layout.bgHeightPct == null;
    bgHeightAutoCheckbox.checked = autoHeight;
    bgHeightRange.disabled = autoHeight;
    bgHeightRange.value = autoHeight ? 28 : layout.bgHeightPct;
    bgHeightValueEl.textContent = autoHeight ? "auto" : layout.bgHeightPct + "%";

    textWidthRange.value = layout.textWidthPct;
    textWidthValueEl.textContent = layout.textWidthPct + "%";
    textHeightRange.value = layout.textHeightPct;
    textHeightValueEl.textContent = layout.textHeightPct + "%";

    textAlignSelect.value = layout.textAlign;
    textHAlignSelect.value = layout.textHAlign;
    fontFamilySelect.value = layout.fontFamily;
    boldCheckbox.checked = layout.bold;
    allCapsCheckbox.checked = layout.allCaps;
  }

  function pushLayoutToPreview() {
    postToPreview({ type: "layout", layout });
  }

  function setLayout(partial) {
    layout = { ...layout, ...partial };
    localStorage.setItem("obs-control:layout", JSON.stringify(layout));
    renderLayoutControls();
    send({ type: "layout", layout });
    pushLayoutToPreview();
    // Font/width changes affect how many lines a slide's text takes up, so
    // keep the song slide list's pagination in sync too.
    if (typeof currentSong !== "undefined" && currentSong) renderSlideList();
  }

  // Reflects a layout that originated elsewhere (server's initial `state`, or
  // another open /control window) without re-broadcasting.
  function syncLayout(next) {
    layout = { ...LAYOUT_DEFAULTS, ...(next || {}) };
    localStorage.setItem("obs-control:layout", JSON.stringify(layout));
    renderLayoutControls();
    pushLayoutToPreview();
    if (typeof currentSong !== "undefined" && currentSong) renderSlideList();
  }

  bgWidthRange.addEventListener("input", () => setLayout({ bgWidthPct: Number(bgWidthRange.value) }));
  bgHeightRange.addEventListener("input", () => setLayout({ bgHeightPct: Number(bgHeightRange.value) }));
  bgHeightAutoCheckbox.addEventListener("change", () => {
    setLayout({ bgHeightPct: bgHeightAutoCheckbox.checked ? null : Number(bgHeightRange.value) });
  });
  textWidthRange.addEventListener("input", () => setLayout({ textWidthPct: Number(textWidthRange.value) }));
  textHeightRange.addEventListener("input", () => setLayout({ textHeightPct: Number(textHeightRange.value) }));
  textAlignSelect.addEventListener("change", () => setLayout({ textAlign: textAlignSelect.value }));
  textHAlignSelect.addEventListener("change", () => setLayout({ textHAlign: textHAlignSelect.value }));
  fontFamilySelect.addEventListener("change", () => setLayout({ fontFamily: fontFamilySelect.value }));
  boldCheckbox.addEventListener("change", () => setLayout({ bold: boldCheckbox.checked }));
  allCapsCheckbox.addEventListener("change", () => setLayout({ allCaps: allCapsCheckbox.checked }));
  layoutResetBtn.addEventListener("click", () => setLayout({ ...LAYOUT_DEFAULTS }));

  renderLayoutControls();

  // ============================================================
  // Tabs
  // ============================================================

  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => switchTab(btn.dataset.tab));
  });

  function switchTab(name) {
    document.querySelectorAll(".tab-btn").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
    document.querySelectorAll(".tab-panel").forEach((p) => p.classList.toggle("active", p.id === "tab-" + name));
    if (name === "songs") ensureSongsLoaded();
    if (name === "announcements") loadAnnouncements();
    if (name === "preview") pushPreview();
  }

  // ============================================================
  // Hide / Clear (always available, safety-critical)
  // ============================================================

  document.getElementById("hideBtn").addEventListener("click", () => {
    send({ type: "hide" });
    renderLiveBanner(false, null);
    // Nothing's actually live anymore - Prev/Next should go back to staging
    // (previewing) rather than pushing invisible live updates.
    currentScriptureIsLive = false;
    currentLyricIsLive = false;
  });

  // ============================================================
  // Text size (global, always available like Hide/Clear — affects
  // whatever's on screen immediately, and applies to future slides too)
  // ============================================================

  const TEXT_SCALE_MIN = 0.7;
  const TEXT_SCALE_MAX = 1.6;
  const TEXT_SCALE_STEP = 0.1;

  const textSizeLabelEl = document.getElementById("textSizeLabel");
  const textSizeDownBtn = document.getElementById("textSizeDownBtn");
  const textSizeUpBtn = document.getElementById("textSizeUpBtn");

  let textScale = 1;
  {
    const saved = Number(localStorage.getItem("obs-control:textScale"));
    if (Number.isFinite(saved) && saved >= TEXT_SCALE_MIN && saved <= TEXT_SCALE_MAX) textScale = saved;
  }

  function renderTextScale() {
    textSizeLabelEl.textContent = Math.round(textScale * 100) + "%";
    textSizeDownBtn.disabled = textScale <= TEXT_SCALE_MIN + 1e-9;
    textSizeUpBtn.disabled = textScale >= TEXT_SCALE_MAX - 1e-9;
  }

  function setTextScale(next) {
    textScale = Math.min(TEXT_SCALE_MAX, Math.max(TEXT_SCALE_MIN, Math.round(next * 100) / 100));
    localStorage.setItem("obs-control:textScale", String(textScale));
    renderTextScale();
    send({ type: "textScale", scale: textScale });
    // The song slide list's pagination (how many lines fit per page) is
    // measured against this size - re-render so it stays accurate if the
    // operator adjusts it mid-service with a song open.
    if (typeof currentSong !== "undefined" && currentSong) renderSlideList();
  }

  // Reflects a scale that originated elsewhere (server's initial `state`, or
  // another open /control window) — updates local UI/storage without
  // re-broadcasting, so two open control windows don't ping-pong each other.
  function syncTextScale(scale) {
    if (scale === textScale) return;
    textScale = scale;
    localStorage.setItem("obs-control:textScale", String(textScale));
    renderTextScale();
    if (typeof currentSong !== "undefined" && currentSong) renderSlideList();
  }

  textSizeDownBtn.addEventListener("click", () => setTextScale(textScale - TEXT_SCALE_STEP));
  textSizeUpBtn.addEventListener("click", () => setTextScale(textScale + TEXT_SCALE_STEP));

  renderTextScale();

  // ============================================================
  // Debounce helper
  // ============================================================

  function debounce(fn, wait) {
    let t = null;
    const wrapped = (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), wait);
    };
    wrapped.cancel = () => clearTimeout(t);
    return wrapped;
  }

  // ============================================================
  // Text splitting: long content -> readable-sized parts, so a very long
  // verse or song stanza doesn't have to be shrunk down to illegibility on
  // the projector. Next/Previous step through the parts before advancing to
  // the actual next verse/slide - see stepVerse/stepSlide below.
  //
  // Parts are capped at MAX_LINES_PER_PART *actual rendered lines*, measured
  // with a real canvas text metrics pass rather than a fixed character-count
  // guess - a guess tuned for the default 100% text size silently overflows
  // once the operator runs a bigger size (e.g. 120%) or a wider/narrower
  // font/box, which is exactly the failure this replaced. The measurement
  // mirrors the real display's CSS (see FONT_FAMILY_STACKS/SLIDE_DEFAULT_*
  // below and display/style.css) at a fixed 1920px-wide reference canvas -
  // the size the README tells operators to set the Browser Source to. Since
  // display/style.css's font-size clamp() maxes out well below what 1920px's
  // vw value would otherwise produce (e.g. 3vw = 57.6px vs a 46px cap), the
  // effective font size at that canvas width is just the cap * text scale,
  // which is what's reproduced here.
  // ============================================================

  const MAX_LINES_PER_PART = 3;
  const REFERENCE_CANVAS_WIDTH_PX = 1920;

  // Must stay in sync with FONT_FAMILY_STACKS in display/app.js.
  const FONT_FAMILY_STACKS = {
    serif: 'Georgia, "Times New Roman", serif',
    sans: '-apple-system, "Segoe UI", Roboto, Arial, sans-serif',
    condensed: '"Arial Narrow", "Segoe UI", sans-serif',
    rounded: 'Calibri, "Trebuchet MS", sans-serif',
  };
  // Each slide type's own default (unstyled) font - matches display/style.css.
  const SLIDE_DEFAULT_FONT = {
    scripture: 'Georgia, "Times New Roman", serif',
    lyric: '-apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
  };
  const SLIDE_DEFAULT_WEIGHT = { scripture: 400, lyric: 600 };
  const SLIDE_ITALIC = { scripture: true, lyric: false };

  function clampPx(minPx, vwFraction, maxPx) {
    return Math.min(maxPx, Math.max(minPx, REFERENCE_CANVAS_WIDTH_PX * vwFraction));
  }

  // .lt-content's own box width (--text-width, set from layout.textWidthPct)
  // minus its horizontal padding (6vw + 5vw - see display/style.css .lt-content).
  function availableTextWidthPx() {
    const boxWidthPx = ((layout.textWidthPct != null ? layout.textWidthPct : 88) / 100) * REFERENCE_CANVAS_WIDTH_PX;
    const horizontalPaddingPx = 0.11 * REFERENCE_CANVAS_WIDTH_PX;
    return Math.max(40, boxWidthPx - horizontalPaddingPx);
  }

  function measureFontFor(slideType, fontPx) {
    const family = FONT_FAMILY_STACKS[layout.fontFamily] || SLIDE_DEFAULT_FONT[slideType];
    const weight = layout.bold ? 700 : SLIDE_DEFAULT_WEIGHT[slideType];
    const style = SLIDE_ITALIC[slideType] ? "italic" : "normal";
    return `${style} ${weight} ${fontPx}px ${family}`;
  }

  // Offscreen canvas used purely for text-metrics (never attached to the DOM).
  const measureCanvas = document.createElement("canvas");
  const measureCtx = measureCanvas.getContext("2d");

  // Greedy word-wrap simulation, returning arrays of WORD INDICES per
  // rendered line (not the words themselves) so callers can map back to the
  // original-case words - `words` here may already be upper-cased for
  // measurement purposes (see splitTextIntoParts) without losing the
  // original casing of the actual content.
  function wrapIndicesToLines(words, font, maxWidthPx) {
    measureCtx.font = font;
    const lines = [[]];
    let width = 0;
    const spaceWidth = measureCtx.measureText(" ").width;
    words.forEach((word, i) => {
      const wordWidth = measureCtx.measureText(word).width;
      const cur = lines[lines.length - 1];
      const candidateWidth = cur.length ? width + spaceWidth + wordWidth : wordWidth;
      if (candidateWidth > maxWidthPx && cur.length) {
        lines.push([i]);
        width = wordWidth;
      } else {
        cur.push(i);
        width = candidateWidth;
      }
    });
    return lines;
  }

  // Splits prose (a scripture verse) into parts of at most MAX_LINES_PER_PART
  // *rendered* lines each, so a long verse breaks at word boundaries that
  // actually fit the box - not just word boundaries under some fixed
  // character count that may or may not match how it actually wraps.
  function splitTextIntoParts(text) {
    const trimmed = String(text || "").trim();
    if (!trimmed) return [""];

    const originalWords = trimmed.split(/\s+/);
    const measureWords = layout.allCaps ? originalWords.map((w) => w.toUpperCase()) : originalWords;
    const fontPx = clampPx(24, 0.03, 46) * textScale;
    const font = measureFontFor("scripture", fontPx);
    const wrappedLines = wrapIndicesToLines(measureWords, font, availableTextWidthPx());

    const parts = [];
    for (let i = 0; i < wrappedLines.length; i += MAX_LINES_PER_PART) {
      const indices = wrappedLines.slice(i, i + MAX_LINES_PER_PART).flat();
      parts.push(indices.map((idx) => originalWords[idx]).join(" "));
    }
    return parts.length ? parts : [trimmed];
  }

  // Splits a song slide's lines (already broken into natural lines by the
  // song data) into parts of at most MAX_LINES_PER_PART *rendered* lines -
  // grouping whole original lines together where they fit, but also
  // accounting for a single long lyric line wrapping into more than one
  // rendered line on its own (same overflow risk as a long scripture verse).
  function splitLinesIntoParts(lines) {
    const safeLines = Array.isArray(lines) ? lines : [];
    if (safeLines.length === 0) return [[]];

    const fontPx = clampPx(24, 0.031, 48) * textScale;
    const font = measureFontFor("lyric", fontPx);
    const maxWidthPx = availableTextWidthPx();

    function renderedRowsFor(line) {
      const words = String(line || "").trim().split(/\s+/).filter(Boolean);
      if (words.length === 0) return 1;
      const measureWords = layout.allCaps ? words.map((w) => w.toUpperCase()) : words;
      return Math.max(1, wrapIndicesToLines(measureWords, font, maxWidthPx).length);
    }

    const parts = [];
    let current = [];
    let currentRows = 0;
    for (const line of safeLines) {
      const rows = renderedRowsFor(line);
      if (current.length && currentRows + rows > MAX_LINES_PER_PART) {
        parts.push(current);
        current = [];
        currentRows = 0;
      }
      current.push(line);
      currentRows += rows;
    }
    if (current.length) parts.push(current);
    return parts.length ? parts : [safeLines];
  }

  // Strips a trailing " (N/M)" part-count suffix, e.g. from a reference or
  // slide label, so matching/parsing logic can work with the base value.
  function stripPartSuffix(str) {
    return String(str || "").replace(/\s*\(\d+\/\d+\)\s*$/, "");
  }

  // ============================================================
  // Scripture tab
  // ============================================================

  const scriptureSearchEl = document.getElementById("scriptureSearch");
  const scriptureResultsEl = document.getElementById("scriptureResults");
  const translationPickerEl = document.getElementById("translationPicker");
  const scriptureNavEl = document.getElementById("scriptureNav");
  const currentVerseLabelEl = document.getElementById("currentVerseLabel");
  const prevVerseBtn = document.getElementById("prevVerseBtn");
  const nextVerseBtn = document.getElementById("nextVerseBtn");
  const saveScriptureBtn = document.getElementById("saveScriptureBtn");
  const savedScripturesRowEl = document.getElementById("savedScripturesRow");
  const autoLiveCheckbox = document.getElementById("autoLiveCheckbox");

  // "Auto display" - when on, picking a verse (click, search-jump, or
  // stepping) puts it straight on screen instead of only staging it, so the
  // operator doesn't have to hit "Display Live" after every single verse
  // while reading through a passage. Persisted like the other per-operator
  // display preferences (translation, text size).
  let scriptureAutoLive = false;
  try {
    scriptureAutoLive = localStorage.getItem("obs-control:scriptureAutoLive") === "1";
  } catch {
    scriptureAutoLive = false;
  }
  autoLiveCheckbox.checked = scriptureAutoLive;
  autoLiveCheckbox.addEventListener("change", () => {
    scriptureAutoLive = autoLiveCheckbox.checked;
    try {
      localStorage.setItem("obs-control:scriptureAutoLive", scriptureAutoLive ? "1" : "0");
    } catch {
      // localStorage unavailable; preference just won't persist across restarts
    }
  });

  let translations = [];
  let selectedTranslation = null;
  let currentScripture = null; // { translation, book, chapter, verse, parts, partIndex }
  // Whether currentScripture is what's actually live right now (vs. merely
  // staged/previewed) - determines whether Prev/Next and translation
  // switching push a live update or just restage. A fresh search result is
  // never live until "Display Live" is clicked.
  let currentScriptureIsLive = false;

  // Builds the content for one part of a (possibly split) verse. `ref` needs
  // book/chapter/verse/translation - either a search result or currentScripture.
  // `reference` is always the clean "Book C:V" form - no "(N/M)" part
  // indicator - since this is exactly what gets broadcast and rendered on
  // the projection; partIndex/totalParts travel alongside it so the control
  // UI can show its own "(N/M)" indicator (see renderScriptureNav) without
  // that ever leaking onto the screen the congregation sees.
  function scriptureContentForPart(ref, parts, partIndex) {
    return {
      reference: `${ref.book} ${ref.chapter}:${ref.verse}`,
      translation: ref.translation,
      text: parts[partIndex],
      partIndex,
      totalParts: parts.length,
    };
  }

  async function loadTranslations() {
    try {
      const res = await fetch("/api/bible/translations");
      translations = await res.json();
    } catch {
      translations = [];
    }

    let saved = null;
    try {
      saved = localStorage.getItem("obs-control:selectedTranslation");
    } catch {
      saved = null;
    }

    selectedTranslation = translations.some((t) => t.id === saved) ? saved : translations.length ? translations[0].id : null;

    renderTranslationPicker();
  }

  function renderTranslationPicker() {
    translationPickerEl.innerHTML = "";
    translations.forEach((t) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "translation-btn" + (t.id === selectedTranslation ? " active" : "");
      btn.appendChild(document.createTextNode(t.id.toUpperCase()));
      if (t.licensed) {
        const tag = document.createElement("span");
        tag.className = "licensed-tag";
        tag.textContent = "licensed";
        btn.appendChild(tag);
      }
      btn.addEventListener("click", () => selectTranslation(t.id));
      translationPickerEl.appendChild(btn);
    });
  }

  function selectTranslation(id) {
    if (id === selectedTranslation) return;
    selectedTranslation = id;
    localStorage.setItem("obs-control:selectedTranslation", id);
    renderTranslationPicker();
    if (scriptureSearchEl.value.trim()) runScriptureSearch();
    // A verse is already picked out (live or just staged) — jump it to the
    // newly selected translation instead of making the operator re-search.
    if (currentScripture) switchCurrentVerseTranslation(id);
  }

  async function switchCurrentVerseTranslation(translationId) {
    if (!currentScripture) return;
    const { book, chapter, verse } = currentScripture;
    try {
      const result = await fetchVerse(translationId, book, chapter, verse);
      if (!result) return;
      const parts = splitTextIntoParts(result.text);
      currentScripture = { translation: result.translation, book: result.book, chapter: result.chapter, verse: result.verse, parts, partIndex: 0 };
      const content = scriptureContentForPart(currentScripture, parts, 0);
      if (currentScriptureIsLive) sendUpdate("scripture", content);
      else stage("scripture", content);
      renderScriptureNav(content);
    } catch {
      // network hiccup on a licensed translation; leave current slide untouched
    }
  }

  async function searchScripture(query, translationId) {
    if (!query.trim() || !translationId) return { results: [], bookMatch: null };
    const params = new URLSearchParams({ q: query, translations: translationId });
    const res = await fetch("/api/bible/search?" + params.toString());
    if (!res.ok) return { results: [], bookMatch: null };
    return res.json();
  }

  function renderScriptureResults(results) {
    scriptureResultsEl.innerHTML = "";
    if (results.length === 0) {
      const hint = document.createElement("div");
      hint.className = "empty-hint";
      hint.textContent = scriptureSearchEl.value.trim() ? "No matches" : "Type a reference (jn 3:16) or keywords";
      scriptureResultsEl.appendChild(hint);
      return;
    }
    results.forEach((r) => {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "result-item";
      item.dataset.book = r.book;
      item.dataset.chapter = r.chapter;
      item.dataset.verse = r.verse;
      item.dataset.translation = r.translation;
      item.innerHTML = `
        <div class="ref-line">
          <span>${escapeHtml(r.book)} ${r.chapter}:${r.verse}</span>
          <span class="translation-badge">${escapeHtml(r.translation)}</span>
        </div>
        <div class="verse-text">${escapeHtml(r.text)}</div>`;
      item.addEventListener("click", () => showScriptureVerse(r));
      scriptureResultsEl.appendChild(item);
    });
    highlightCurrentScriptureResult();
  }

  // Keeps the search-results list's highlight in sync with whatever verse is
  // actually current (staged or live) - without this, a result item's
  // highlight was never wired to anything, so it looked visually "stuck" on
  // whichever item you'd clicked even as arrow-key stepping moved on to
  // other verses. Matches by reference rather than re-rendering the whole
  // list, since arrow-stepped verses aren't necessarily in the results list
  // at all (nothing to highlight in that case, which is correct).
  function highlightCurrentScriptureResult() {
    let activeItem = null;
    scriptureResultsEl.querySelectorAll(".result-item").forEach((item) => {
      const isCurrent =
        !!currentScripture &&
        item.dataset.book === currentScripture.book &&
        Number(item.dataset.chapter) === currentScripture.chapter &&
        Number(item.dataset.verse) === currentScripture.verse &&
        item.dataset.translation === currentScripture.translation;
      item.classList.toggle("active", isCurrent);
      if (isCurrent) activeItem = item;
    });
    // Keep the highlighted row in view as the operator arrow-steps through
    // verses, so what's on screen never scrolls out of sight while stepping.
    scrollActiveIntoView(activeItem);
  }

  const debouncedScriptureSearch = debounce(runScriptureSearch, 150);

  let lastScriptureResults = [];
  // Tracks the last book we auto-jumped to, so typing more of the same book
  // name (e.g. "jos" -> "josh" -> "joshua") doesn't keep re-fetching/
  // re-staging chapter 1 verse 1 on every keystroke once it's already there.
  let lastBookJump = null;

  // "Speed" search-as-you-type: the instant what's typed unambiguously names
  // a book (see resolveUniqueBookPrefix server-side), jump straight to its
  // chapter 1 verse 1 - staged, not live, same as any other fresh selection.
  // Naturally stops firing once more of a real reference is typed (e.g.
  // "joshua 3"), since that no longer just names a bare book.
  async function maybeJumpToBook(bookName) {
    if (!bookName || bookName === lastBookJump || !selectedTranslation) return;
    lastBookJump = bookName;
    try {
      const result = await fetchVerse(selectedTranslation, bookName, 1, 1);
      if (!result) return;
      const parts = splitTextIntoParts(result.text);
      currentScripture = { translation: result.translation, book: result.book, chapter: result.chapter, verse: result.verse, parts, partIndex: 0 };
      const content = scriptureContentForPart(currentScripture, parts, 0);
      currentScriptureIsLive = stageOrGoLive("scripture", content, scriptureAutoLive);
      renderScriptureNav(content);
    } catch {
      // network hiccup; leave whatever's staged untouched
    }
  }

  async function runScriptureSearch() {
    const query = scriptureSearchEl.value;
    const { results, bookMatch } = await searchScripture(query, selectedTranslation);
    lastScriptureResults = results;
    renderScriptureResults(results);
    if (bookMatch) maybeJumpToBook(bookMatch);
    else lastBookJump = null;
    return results;
  }

  scriptureSearchEl.addEventListener("input", () => debouncedScriptureSearch());

  scriptureSearchEl.addEventListener("keydown", async (e) => {
    if (e.key === "Enter") {
      debouncedScriptureSearch.cancel();
      const results = await runScriptureSearch();
      if (results.length > 0) showScriptureVerse(results[0]);
    }
  });

  function showScriptureVerse(verse) {
    const parts = splitTextIntoParts(verse.text);
    currentScripture = { translation: verse.translation, book: verse.book, chapter: verse.chapter, verse: verse.verse, parts, partIndex: 0 };
    // A freshly picked search result is a new selection - normally staged for
    // preview/confirmation rather than assuming it should replace whatever's
    // currently live, UNLESS "Auto display" is on, in which case it goes
    // straight to screen (that's the whole point of the toggle).
    const content = scriptureContentForPart(currentScripture, parts, 0);
    currentScriptureIsLive = stageOrGoLive("scripture", content, scriptureAutoLive);
    renderScriptureNav(content);
  }

  function renderScriptureNav(content) {
    scriptureNavEl.hidden = false;
    // The "(N/M)" part indicator is UI-only - content.reference itself stays
    // clean since it's exactly what gets broadcast to the projection.
    const partSuffix = content.totalParts > 1 ? ` (${content.partIndex + 1}/${content.totalParts})` : "";
    currentVerseLabelEl.textContent = `${content.reference}${partSuffix} (${content.translation.toUpperCase()})`;
    highlightCurrentScriptureResult();
  }

  async function fetchVerse(translation, book, chapter, verse) {
    const params = new URLSearchParams({ translation, book, chapter: String(chapter), verse: String(verse) });
    const res = await fetch("/api/bible/verse?" + params.toString());
    if (res.status === 404) return null;
    if (!res.ok) throw new Error("verse lookup failed");
    return res.json();
  }

  async function stepVerse(delta) {
    if (!currentScripture) return;

    // If the current verse is split into parts, step within it first -
    // only fall through to fetching an actual different verse once we're
    // off the start/end of the parts. (parts may be absent if currentScripture
    // came from reconciling another window's live state rather than our own
    // fetch - treat that the same as "not split".)
    if (currentScripture.parts && currentScripture.parts.length > 1) {
      const nextPartIndex = currentScripture.partIndex + delta;
      if (nextPartIndex >= 0 && nextPartIndex < currentScripture.parts.length) {
        currentScripture.partIndex = nextPartIndex;
        const content = scriptureContentForPart(currentScripture, currentScripture.parts, nextPartIndex);
        if (currentScriptureIsLive) sendUpdate("scripture", content);
        else stage("scripture", content);
        renderScriptureNav(content);
        return;
      }
    }

    const { translation, book, chapter, verse } = currentScripture;
    let targetChapter = chapter;
    let targetVerse = verse + delta;

    if (targetVerse < 1) {
      targetChapter = chapter - 1;
      targetVerse = 1;
      if (targetChapter < 1) return; // start of book, nothing more to do
    }

    prevVerseBtn.disabled = nextVerseBtn.disabled = true;
    try {
      let result = await fetchVerse(translation, book, targetChapter, targetVerse);
      if (!result && delta > 0) {
        // ran off the end of the chapter -> jump to the start of the next one
        result = await fetchVerse(translation, book, chapter + 1, 1);
      }
      if (!result) return; // likely end/start of book; leave as-is

      const parts = splitTextIntoParts(result.text);
      // Stepping backward off the start of a split verse lands on the LAST
      // part of the previous verse, not its first - feels like continuous
      // backward reading rather than jumping ahead again.
      const partIndex = delta < 0 ? parts.length - 1 : 0;
      currentScripture = { translation: result.translation, book: result.book, chapter: result.chapter, verse: result.verse, parts, partIndex };
      const content = scriptureContentForPart(currentScripture, parts, partIndex);
      if (currentScriptureIsLive) sendUpdate("scripture", content);
      else stage("scripture", content);
      renderScriptureNav(content);
    } catch {
      // network hiccup; leave current slide untouched
    } finally {
      prevVerseBtn.disabled = nextVerseBtn.disabled = false;
    }
  }

  prevVerseBtn.addEventListener("click", () => stepVerse(-1));
  nextVerseBtn.addEventListener("click", () => stepVerse(1));

  // Arrow-key stepping through the current passage/song, mirroring Prev/Next
  // - only while the relevant tab is showing and something is actually
  // selected, so arrow keys elsewhere (typing in another tab's textarea,
  // etc.) are unaffected. Ignored while typing in a text field EXCEPT the
  // scripture search box itself, where up/down do nothing useful otherwise.
  document.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const active = document.activeElement;
    const typingElsewhere = active && (active.tagName === "TEXTAREA" || (active.tagName === "INPUT" && active !== scriptureSearchEl));
    if (typingElsewhere) return;

    if (document.getElementById("tab-scripture").classList.contains("active")) {
      if (!currentScripture) return;
      e.preventDefault();
      stepVerse(e.key === "ArrowDown" ? 1 : -1);
    } else if (document.getElementById("tab-songs").classList.contains("active")) {
      if (!currentSong || songDetailEl.hidden) return;
      e.preventDefault();
      stepSlide(e.key === "ArrowDown" ? 1 : -1);
    }
  });

  // ============================================================
  // Saved scriptures - bookmark a verse (e.g. today's sermon text) and
  // recall it with one click later, without needing to re-search. Persisted
  // server-side (data/scripture-bookmarks/bookmarks.json) so it survives
  // restarts, same as announcements/songs.
  // ============================================================

  let savedScriptures = [];

  async function loadScriptureBookmarks() {
    try {
      const res = await fetch("/api/scripture-bookmarks");
      savedScriptures = await res.json();
    } catch {
      savedScriptures = [];
    }
    renderSavedScriptures();
  }

  function renderSavedScriptures() {
    savedScripturesRowEl.innerHTML = "";
    savedScripturesRowEl.hidden = savedScriptures.length === 0;
    savedScriptures.forEach((b) => {
      const pill = document.createElement("button");
      pill.type = "button";
      pill.className = "saved-scripture-pill";
      pill.title = `Load ${b.book} ${b.chapter}:${b.verse} (${b.translation.toUpperCase()})`;
      pill.innerHTML = `<span>${escapeHtml(b.book)} ${b.chapter}:${b.verse}</span>`;
      pill.addEventListener("click", () => loadSavedScripture(b));

      const removeBtn = document.createElement("button");
      removeBtn.type = "button";
      removeBtn.className = "remove-saved";
      removeBtn.title = "Remove this saved verse";
      removeBtn.textContent = "×";
      removeBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        removeSavedScripture(b.id);
      });
      pill.appendChild(removeBtn);

      savedScripturesRowEl.appendChild(pill);
    });
  }

  async function loadSavedScripture(b) {
    try {
      const result = await fetchVerse(b.translation, b.book, b.chapter, b.verse);
      if (!result) return;
      // A saved translation might not be selected/loaded right now (e.g. a
      // licensed one that isn't currently active) - switch the picker to
      // match so what's shown lines up with what's selected.
      if (result.translation !== selectedTranslation && translations.some((t) => t.id === result.translation)) {
        selectedTranslation = result.translation;
        localStorage.setItem("obs-control:selectedTranslation", selectedTranslation);
        renderTranslationPicker();
      }
      const parts = splitTextIntoParts(result.text);
      currentScripture = { translation: result.translation, book: result.book, chapter: result.chapter, verse: result.verse, parts, partIndex: 0 };
      const content = scriptureContentForPart(currentScripture, parts, 0);
      currentScriptureIsLive = stageOrGoLive("scripture", content, scriptureAutoLive);
      renderScriptureNav(content);
    } catch {
      // network hiccup; leave whatever's staged/live untouched
    }
  }

  async function removeSavedScripture(id) {
    try {
      const res = await fetch(`/api/scripture-bookmarks/${encodeURIComponent(id)}`, { method: "DELETE" });
      savedScriptures = await res.json();
    } catch {
      savedScriptures = savedScriptures.filter((b) => b.id !== id);
    }
    renderSavedScriptures();
  }

  saveScriptureBtn.addEventListener("click", async () => {
    if (!currentScripture) return;
    const { book, chapter, verse, translation } = currentScripture;
    try {
      const res = await fetch("/api/scripture-bookmarks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ book, chapter, verse, translation }),
      });
      savedScriptures = await res.json();
      renderSavedScriptures();
    } catch {
      // network hiccup; nothing saved, nothing else to do
    }
  });

  loadScriptureBookmarks();

  function parseReference(ref) {
    // "John 3:16" / "1 John 3:16" (optionally with a trailing " (1/2)" part
    // suffix, stripped first) -> { book, chapter, verse }
    const cleaned = stripPartSuffix(String(ref || "").trim());
    const m = /^(.+)\s+(\d+):(\d+)$/.exec(cleaned);
    if (!m) return null;
    return { book: m[1], chapter: Number(m[2]), verse: Number(m[3]) };
  }

  loadTranslations().then(() => renderScriptureResults([]));

  // ============================================================
  // Songs tab
  // ============================================================

  const songSearchEl = document.getElementById("songSearch");
  const songListEl = document.getElementById("songList");
  const songDetailEl = document.getElementById("songDetail");
  const songDetailTitleEl = document.getElementById("songDetailTitle");
  const slideListEl = document.getElementById("slideList");
  const currentSlideLabelEl = document.getElementById("currentSlideLabel");
  const prevSlideBtn = document.getElementById("prevSlideBtn");
  const nextSlideBtn = document.getElementById("nextSlideBtn");
  const autoLiveCheckboxSongs = document.getElementById("autoLiveCheckboxSongs");
  const editSongBtn = document.getElementById("editSongBtn");
  const songEditPanelEl = document.getElementById("songEditPanel");
  const songEditTitleInput = document.getElementById("songEditTitleInput");
  const songEditSlidesEl = document.getElementById("songEditSlides");
  const addSlideBtn = document.getElementById("addSlideBtn");
  const saveSongBtn = document.getElementById("saveSongBtn");
  const cancelEditSongBtn = document.getElementById("cancelEditSongBtn");
  const deleteSongBtn = document.getElementById("deleteSongBtn");
  const songEditStatusEl = document.getElementById("songEditStatus");

  // "Auto display" for songs - same idea as scripture's, but defaults ON:
  // a song service is fast-paced (click a slide, it needs to be on screen
  // immediately, not staged-then-confirmed), so skipping the extra
  // "Display Live" step is the expected default here rather than an opt-in.
  let lyricAutoLive = true;
  try {
    const saved = localStorage.getItem("obs-control:lyricAutoLive");
    if (saved !== null) lyricAutoLive = saved === "1";
  } catch {
    lyricAutoLive = true;
  }
  autoLiveCheckboxSongs.checked = lyricAutoLive;
  autoLiveCheckboxSongs.addEventListener("change", () => {
    lyricAutoLive = autoLiveCheckboxSongs.checked;
    try {
      localStorage.setItem("obs-control:lyricAutoLive", lyricAutoLive ? "1" : "0");
    } catch {
      // localStorage unavailable; preference just won't persist across restarts
    }
  });

  let songsIndex = [];
  let songsLoaded = false;
  let currentSong = null; // full song object { id, title, slides }
  let currentSlideIndex = -1;
  let currentSlideParts = null; // array of line-arrays for currentSong.slides[currentSlideIndex], or null
  let currentSlidePartIndex = 0;
  let pendingLyricRestore = null; // content from a `state`/`show` we couldn't resolve yet
  // Whether currentSong/currentSlideIndex is what's actually live right now
  // (vs. merely staged/previewed) - same role as currentScriptureIsLive.
  let currentLyricIsLive = false;

  // Builds the content for one part of a (possibly split) slide.
  // slideLabel is always the clean slide label - no "(N/M)" part indicator
  // - since this is exactly what gets broadcast and rendered on the
  // projection; the control UI builds its own indicator separately (see
  // updateSlideNavLabel/renderSlideList) from partIndex/totalParts instead.
  function slideContentForPart(slide, parts, partIndex) {
    return { songTitle: currentSong.title, slideLabel: slide.label, lines: parts[partIndex], partIndex, totalParts: parts.length };
  }

  async function ensureSongsLoaded() {
    if (songsLoaded) return;
    try {
      const res = await fetch("/api/songs");
      songsIndex = await res.json();
      songsLoaded = true;
      renderSongList(songSearchEl.value);
      if (pendingLyricRestore) {
        const content = pendingLyricRestore;
        pendingLyricRestore = null;
        restoreLyricNavContext(content);
      }
    } catch {
      songsIndex = [];
    }
  }

  function renderSongList(filter) {
    const q = (filter || "").trim().toLowerCase();
    const matches = q ? songsIndex.filter((s) => s.title.toLowerCase().includes(q)) : songsIndex;
    songListEl.innerHTML = "";
    if (matches.length === 0) {
      const hint = document.createElement("div");
      hint.className = "empty-hint";
      hint.textContent = songsIndex.length ? "No matches" : "No songs yet";
      songListEl.appendChild(hint);
      return;
    }
    matches.forEach((s) => {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "result-item song-item";
      item.innerHTML = `<span>${escapeHtml(s.title)}</span>`;
      item.addEventListener("click", () => openSong(s.id));
      songListEl.appendChild(item);
    });
  }

  songSearchEl.addEventListener("input", () => renderSongList(songSearchEl.value));

  async function openSong(id, opts) {
    const silent = opts && opts.silent;
    try {
      const res = await fetch(`/api/songs/${encodeURIComponent(id)}`);
      if (!res.ok) return;
      currentSong = await res.json();
    } catch {
      return;
    }
    currentSlideIndex = -1;
    currentSlideParts = null;
    currentSlidePartIndex = 0;
    if (editingSlides) closeSongEditor(); // leaving one song's editor open shouldn't leak into the next
    // Hide the (potentially long) song list while viewing a song's lyrics -
    // otherwise it sits above the slide list in the DOM and you'd have to
    // scroll past every song title before reaching the actual lyrics.
    songListEl.hidden = true;
    songDetailEl.hidden = false;
    songDetailTitleEl.textContent = currentSong.title;
    renderSlideList();
    if (!silent && currentSong.slides.length > 0) {
      selectSlide(0);
    }
  }

  document.getElementById("backToSongsBtn").addEventListener("click", () => {
    if (editingSlides) closeSongEditor();
    songDetailEl.hidden = true;
    songListEl.hidden = false;
  });

  // One row per actual on-screen page (not one row per raw slide) - each
  // slide is pre-split into its 3-line-capped parts, at whatever text
  // size/font/layout is currently configured, so the operator can click
  // straight to the exact page they want instead of picking a slide and
  // then blindly stepping through its parts with Prev/Next/arrows.
  function renderSlideList() {
    slideListEl.innerHTML = "";
    let activeItem = null;
    (currentSong.slides || []).forEach((slide, slideIdx) => {
      const parts = splitLinesIntoParts(slide.lines);
      parts.forEach((partLines, partIdx) => {
        const item = document.createElement("button");
        item.type = "button";
        const isActive = slideIdx === currentSlideIndex && partIdx === currentSlidePartIndex;
        item.className = "result-item slide-item" + (isActive ? " active" : "");
        const label = parts.length > 1 ? `${slide.label} (${partIdx + 1}/${parts.length})` : slide.label;
        item.innerHTML = `<div class="slide-label">${escapeHtml(label)}</div><div class="slide-lines">${escapeHtml(partLines.join("\n"))}</div>`;
        item.addEventListener("click", () => selectSlidePart(slideIdx, partIdx));
        slideListEl.appendChild(item);
        if (isActive) activeItem = item;
      });
    });
    updateSlideNavLabel();
    // Keep the highlighted page in view as the operator arrow-steps/Prev-
    // Nexts through a song, so what's on screen never scrolls out of sight.
    scrollActiveIntoView(activeItem);
  }

  function updateSlideNavLabel() {
    if (!currentSong || currentSlideIndex < 0) {
      currentSlideLabelEl.textContent = "";
      return;
    }
    const slide = currentSong.slides[currentSlideIndex];
    if (!slide) {
      currentSlideLabelEl.textContent = "";
      return;
    }
    let label = `${currentSlideIndex + 1}/${currentSong.slides.length} — ${slide.label}`;
    if (currentSlideParts && currentSlideParts.length > 1) label += ` (${currentSlidePartIndex + 1}/${currentSlideParts.length})`;
    currentSlideLabelEl.textContent = label;
  }

  // Selects a specific page (slideIdx/partIdx) fresh and stages or
  // live-updates it depending on lyricAutoLive - a direct click on any row
  // in the (now per-page) slide list, or auto-opening a song's first page,
  // goes straight on screen when "Auto display" is on (the default for
  // songs), otherwise stages for preview/confirmation.
  function selectSlidePart(slideIdx, partIdx) {
    if (!currentSong || slideIdx < 0 || slideIdx >= currentSong.slides.length) return;
    currentSlideIndex = slideIdx;
    const slide = currentSong.slides[slideIdx];
    currentSlideParts = splitLinesIntoParts(slide.lines);
    currentSlidePartIndex = Math.min(Math.max(partIdx, 0), currentSlideParts.length - 1);
    const content = slideContentForPart(slide, currentSlideParts, currentSlidePartIndex);
    currentLyricIsLive = stageOrGoLive("lyric", content, lyricAutoLive);
    renderSlideList();
  }

  function selectSlide(idx) {
    selectSlidePart(idx, 0);
  }

  // Prev/Next: steps within the current slide's parts first (if split),
  // only advancing to an actual different slide once off the start/end of
  // the parts - keeps whatever was already true (live update vs. restage).
  function stepSlide(delta) {
    if (!currentSong || currentSlideIndex < 0) return;

    if (currentSlideParts && currentSlideParts.length > 1) {
      const nextPart = currentSlidePartIndex + delta;
      if (nextPart >= 0 && nextPart < currentSlideParts.length) {
        currentSlidePartIndex = nextPart;
        const slide = currentSong.slides[currentSlideIndex];
        const content = slideContentForPart(slide, currentSlideParts, nextPart);
        if (currentLyricIsLive) sendUpdate("lyric", content);
        else stage("lyric", content);
        renderSlideList();
        return;
      }
    }

    const targetIdx = currentSlideIndex + delta;
    if (targetIdx < 0 || targetIdx >= currentSong.slides.length) return;
    currentSlideIndex = targetIdx;
    const slide = currentSong.slides[targetIdx];
    currentSlideParts = splitLinesIntoParts(slide.lines);
    // Stepping backward off the start of a split slide lands on its LAST
    // part, matching the equivalent scripture behavior.
    currentSlidePartIndex = delta < 0 ? currentSlideParts.length - 1 : 0;
    const content = slideContentForPart(slide, currentSlideParts, currentSlidePartIndex);
    if (currentLyricIsLive) sendUpdate("lyric", content);
    else stage("lyric", content);
    renderSlideList();
  }

  prevSlideBtn.addEventListener("click", () => stepSlide(-1));
  nextSlideBtn.addEventListener("click", () => stepSlide(1));

  // Best-effort reconstruction of "which slide of which song is live" after a
  // reload or when another /control window drives the change.
  function restoreLyricNavContext(content) {
    if (!songsLoaded) {
      pendingLyricRestore = content;
      return;
    }
    const match = songsIndex.find((s) => s.title === content.songTitle);
    if (!match) return;
    fetch(`/api/songs/${encodeURIComponent(match.id)}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((song) => {
        if (!song) return;
        currentSong = song;
        const targetLabel = stripPartSuffix(content.slideLabel);
        const idx = song.slides.findIndex((sl) => sl.label === targetLabel);
        if (idx >= 0) {
          currentSlideIndex = idx;
          currentSlideParts = splitLinesIntoParts(song.slides[idx].lines);
          const partIdx = currentSlideParts.findIndex((p) => JSON.stringify(p) === JSON.stringify(content.lines));
          currentSlidePartIndex = partIdx >= 0 ? partIdx : 0;
          currentLyricIsLive = true;
        } else {
          currentSlideIndex = -1;
          currentSlideParts = null;
          currentSlidePartIndex = 0;
        }
        if (editingSlides) closeSongEditor(); // another window's action shouldn't leave a stale local edit open
        songListEl.hidden = true;
        songDetailEl.hidden = false;
        songDetailTitleEl.textContent = song.title;
        renderSlideList();
      })
      .catch(() => {});
  }

  // ============================================================
  // Song editor - rename the song, edit/add/delete/reorder slides, or
  // delete the whole song. Edits a working copy (editingSlides) so nothing
  // is written to disk until "Save changes" is explicitly clicked.
  // ============================================================

  let editingSlides = null; // [{ label, lines: string[] }, ...] while editing, else null

  function openSongEditor() {
    if (!currentSong) return;
    editingSlides = currentSong.slides.map((s) => ({ label: s.label, lines: [...s.lines] }));
    songEditTitleInput.value = currentSong.title;
    songEditStatusEl.textContent = "";
    renderSongEditSlides();
    slideListEl.hidden = true;
    document.getElementById("slideNav").hidden = true;
    songEditPanelEl.hidden = false;
  }

  function closeSongEditor() {
    editingSlides = null;
    songEditPanelEl.hidden = true;
    slideListEl.hidden = false;
    document.getElementById("slideNav").hidden = false;
  }

  // Reads whatever's currently typed in each row's label/lines back into
  // editingSlides - called before any add/move/delete so re-rendering the
  // list (which rebuilds every row from editingSlides) doesn't discard
  // in-progress edits to slides other than the one just acted on.
  function syncEditingSlidesFromDom() {
    if (!editingSlides) return;
    songEditSlidesEl.querySelectorAll(".song-edit-slide").forEach((row, idx) => {
      if (!editingSlides[idx]) return;
      editingSlides[idx].label = row.querySelector(".song-edit-slide-label").value;
      editingSlides[idx].lines = row.querySelector(".song-edit-slide-lines").value.split("\n");
    });
  }

  function renderSongEditSlides() {
    songEditSlidesEl.innerHTML = "";
    editingSlides.forEach((slide, idx) => {
      const row = document.createElement("div");
      row.className = "song-edit-slide";
      row.innerHTML = `
        <div class="song-edit-slide-head">
          <input class="song-edit-slide-label" type="text" value="${escapeHtml(slide.label)}" placeholder="Slide label (e.g. Verse 1)" />
          <div class="song-edit-slide-actions">
            <button type="button" class="move-up-btn" title="Move up" ${idx === 0 ? "disabled" : ""}>&#9650;</button>
            <button type="button" class="move-down-btn" title="Move down" ${idx === editingSlides.length - 1 ? "disabled" : ""}>&#9660;</button>
            <button type="button" class="delete-slide-btn" title="Delete slide">&#10005;</button>
          </div>
        </div>
        <textarea class="song-edit-slide-lines" rows="4" placeholder="One line per row">${escapeHtml(slide.lines.join("\n"))}</textarea>`;
      row.querySelector(".move-up-btn").addEventListener("click", () => {
        syncEditingSlidesFromDom();
        if (idx > 0) [editingSlides[idx - 1], editingSlides[idx]] = [editingSlides[idx], editingSlides[idx - 1]];
        renderSongEditSlides();
      });
      row.querySelector(".move-down-btn").addEventListener("click", () => {
        syncEditingSlidesFromDom();
        if (idx < editingSlides.length - 1) [editingSlides[idx + 1], editingSlides[idx]] = [editingSlides[idx], editingSlides[idx + 1]];
        renderSongEditSlides();
      });
      row.querySelector(".delete-slide-btn").addEventListener("click", () => {
        syncEditingSlidesFromDom();
        editingSlides.splice(idx, 1);
        renderSongEditSlides();
      });
      songEditSlidesEl.appendChild(row);
    });
  }

  editSongBtn.addEventListener("click", openSongEditor);
  cancelEditSongBtn.addEventListener("click", closeSongEditor);

  addSlideBtn.addEventListener("click", () => {
    syncEditingSlidesFromDom();
    editingSlides.push({ label: `Slide ${editingSlides.length + 1}`, lines: [""] });
    renderSongEditSlides();
  });

  saveSongBtn.addEventListener("click", async () => {
    syncEditingSlidesFromDom();
    const title = songEditTitleInput.value.trim();
    if (!title) {
      songEditStatusEl.textContent = "Title can't be empty.";
      return;
    }
    const slides = editingSlides
      .map((s) => {
        const lines = s.lines.map((l) => l.trim());
        while (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
        return { label: s.label.trim() || "Untitled", lines };
      })
      .filter((s) => s.lines.some((l) => l));
    saveSongBtn.disabled = true;
    songEditStatusEl.textContent = "Saving…";
    try {
      const res = await fetch(`/api/songs/${encodeURIComponent(currentSong.id)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, slides }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "save failed");
      currentSong = await res.json();
      songsLoaded = false; // force a refresh so the song list picks up a renamed title
      await ensureSongsLoaded();
      songDetailTitleEl.textContent = currentSong.title;
      currentSlideIndex = -1;
      currentSlideParts = null;
      currentSlidePartIndex = 0;
      currentLyricIsLive = false;
      closeSongEditor();
      renderSlideList();
      songEditStatusEl.textContent = "";
    } catch (err) {
      songEditStatusEl.textContent = `Could not save: ${err.message}`;
    } finally {
      saveSongBtn.disabled = false;
    }
  });

  deleteSongBtn.addEventListener("click", async () => {
    if (!currentSong) return;
    if (!confirm(`Delete "${currentSong.title}"? This can't be undone.`)) return;
    deleteSongBtn.disabled = true;
    try {
      const res = await fetch(`/api/songs/${encodeURIComponent(currentSong.id)}`, { method: "DELETE" });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "delete failed");
      songsLoaded = false;
      await ensureSongsLoaded();
      currentSong = null;
      currentSlideIndex = -1;
      currentSlideParts = null;
      currentSlidePartIndex = 0;
      currentLyricIsLive = false;
      closeSongEditor();
      songDetailEl.hidden = true;
      songListEl.hidden = false;
    } catch (err) {
      songEditStatusEl.textContent = `Could not delete: ${err.message}`;
    } finally {
      deleteSongBtn.disabled = false;
    }
  });

  // ============================================================
  // Announcements tab
  // ============================================================

  const announcementListEl = document.getElementById("announcementList");
  const annTitleEl = document.getElementById("annTitle");
  const annBodyEl = document.getElementById("annBody");
  const annSaveStatusEl = document.getElementById("annSaveStatus");

  let announcementsLoaded = false;

  async function loadAnnouncements(force) {
    if (announcementsLoaded && !force) return;
    try {
      const res = await fetch("/api/announcements");
      const list = await res.json();
      announcementsLoaded = true;
      renderAnnouncements(list);
    } catch {
      renderAnnouncements([]);
    }
  }

  function renderAnnouncements(list) {
    announcementListEl.innerHTML = "";
    if (list.length === 0) {
      const hint = document.createElement("div");
      hint.className = "empty-hint";
      hint.textContent = "No saved announcements yet";
      announcementListEl.appendChild(hint);
      return;
    }
    list.forEach((a) => {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "result-item announcement-item";
      item.innerHTML = `<div class="ann-title">${escapeHtml(a.title)}</div><div class="ann-body">${escapeHtml(a.body || "")}</div>`;
      item.addEventListener("click", () => showAnnouncement(a));
      announcementListEl.appendChild(item);
    });
  }

  function showAnnouncement(a) {
    const content = { title: a.title, body: a.body || "" };
    stage("announcement", content);
  }

  document.getElementById("annShowBtn").addEventListener("click", () => {
    const title = annTitleEl.value.trim();
    if (!title) {
      annTitleEl.focus();
      return;
    }
    showAnnouncement({ title, body: annBodyEl.value });
  });

  document.getElementById("annSaveBtn").addEventListener("click", async () => {
    const title = annTitleEl.value.trim();
    if (!title) {
      annTitleEl.focus();
      return;
    }
    try {
      const res = await fetch("/api/announcements", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, body: annBodyEl.value }),
      });
      if (!res.ok) throw new Error("save failed");
      const list = await res.json();
      renderAnnouncements(list);
      annSaveStatusEl.textContent = "Saved.";
      setTimeout(() => (annSaveStatusEl.textContent = ""), 2000);
    } catch {
      annSaveStatusEl.textContent = "Save failed.";
      annSaveStatusEl.style.color = "var(--danger)";
    }
  });
})();
