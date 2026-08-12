(() => {
  "use strict";

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
  function reconcileLiveState(current) {
    if (current.slideType === "scripture") {
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
        // works correctly for the verse-to-verse case either way.
        const partMatch = /\((\d+)\/(\d+)\)\s*$/.exec(current.content.reference || "");
        const parts = splitTextIntoParts(current.content.text);
        const partIndex = partMatch ? Math.max(0, Math.min(parts.length - 1, Number(partMatch[1]) - 1)) : 0;
        currentScripture = { translation: current.content.translation, ...parsed, parts, partIndex };
        currentScriptureIsLive = true;
        renderScriptureNav(current.content);
      }
    } else if (current.slideType === "lyric") {
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

  function sendShow(type, content) {
    lastContent[type] = content;
    const full = withBackground(type, content);
    send({ type: "show", slideType: type, content: full });
    renderLiveBanner(true, { slideType: type, content: full });
  }

  function sendUpdate(type, content) {
    lastContent[type] = content;
    const full = withBackground(type, content);
    send({ type: "update", content: full });
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

  const LAYOUT_DEFAULTS = { bgWidthPct: 100, bgHeightPct: null, textWidthPct: 88, textHeightPct: 28 };

  const bgWidthRange = document.getElementById("bgWidthRange");
  const bgWidthValueEl = document.getElementById("bgWidthValue");
  const bgHeightAutoCheckbox = document.getElementById("bgHeightAutoCheckbox");
  const bgHeightRange = document.getElementById("bgHeightRange");
  const bgHeightValueEl = document.getElementById("bgHeightValue");
  const textWidthRange = document.getElementById("textWidthRange");
  const textWidthValueEl = document.getElementById("textWidthValue");
  const textHeightRange = document.getElementById("textHeightRange");
  const textHeightValueEl = document.getElementById("textHeightValue");
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
  }

  // Reflects a layout that originated elsewhere (server's initial `state`, or
  // another open /control window) without re-broadcasting.
  function syncLayout(next) {
    layout = { ...LAYOUT_DEFAULTS, ...(next || {}) };
    localStorage.setItem("obs-control:layout", JSON.stringify(layout));
    renderLayoutControls();
    pushLayoutToPreview();
  }

  bgWidthRange.addEventListener("input", () => setLayout({ bgWidthPct: Number(bgWidthRange.value) }));
  bgHeightRange.addEventListener("input", () => setLayout({ bgHeightPct: Number(bgHeightRange.value) }));
  bgHeightAutoCheckbox.addEventListener("change", () => {
    setLayout({ bgHeightPct: bgHeightAutoCheckbox.checked ? null : Number(bgHeightRange.value) });
  });
  textWidthRange.addEventListener("input", () => setLayout({ textWidthPct: Number(textWidthRange.value) }));
  textHeightRange.addEventListener("input", () => setLayout({ textHeightPct: Number(textHeightRange.value) }));
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
  }

  // Reflects a scale that originated elsewhere (server's initial `state`, or
  // another open /control window) — updates local UI/storage without
  // re-broadcasting, so two open control windows don't ping-pong each other.
  function syncTextScale(scale) {
    if (scale === textScale) return;
    textScale = scale;
    localStorage.setItem("obs-control:textScale", String(textScale));
    renderTextScale();
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
  // ============================================================

  const SCRIPTURE_MAX_CHARS_PER_PART = 200; // roughly a comfortably-readable chunk at the display's default font size
  const LYRIC_MAX_LINES_PER_PART = 4; // matches typical song "block" sizes

  // Splits prose (a scripture verse) into parts by greedily packing whole
  // words up to maxChars, so a very long verse (common in OT narrative)
  // breaks at word boundaries instead of overflowing the text box.
  function splitTextIntoParts(text, maxChars) {
    maxChars = maxChars || SCRIPTURE_MAX_CHARS_PER_PART;
    const trimmed = String(text || "").trim();
    if (trimmed.length <= maxChars) return [trimmed];

    const words = trimmed.split(/\s+/);
    const parts = [];
    let current = "";
    for (const word of words) {
      const candidate = current ? current + " " + word : word;
      if (candidate.length > maxChars && current) {
        parts.push(current);
        current = word;
      } else {
        current = candidate;
      }
    }
    if (current) parts.push(current);
    return parts.length ? parts : [trimmed];
  }

  // Splits a song slide's lines (already broken into natural lines by the
  // song data) into groups of at most maxLines each.
  function splitLinesIntoParts(lines, maxLines) {
    maxLines = maxLines || LYRIC_MAX_LINES_PER_PART;
    const safeLines = Array.isArray(lines) ? lines : [];
    if (safeLines.length <= maxLines) return [safeLines];
    const parts = [];
    for (let i = 0; i < safeLines.length; i += maxLines) {
      parts.push(safeLines.slice(i, i + maxLines));
    }
    return parts;
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
  function scriptureContentForPart(ref, parts, partIndex) {
    const text = parts[partIndex];
    const reference =
      parts.length > 1
        ? `${ref.book} ${ref.chapter}:${ref.verse} (${partIndex + 1}/${parts.length})`
        : `${ref.book} ${ref.chapter}:${ref.verse}`;
    return { reference, translation: ref.translation, text };
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
      item.innerHTML = `
        <div class="ref-line">
          <span>${escapeHtml(r.book)} ${r.chapter}:${r.verse}</span>
          <span class="translation-badge">${escapeHtml(r.translation)}</span>
        </div>
        <div class="verse-text">${escapeHtml(r.text)}</div>`;
      item.addEventListener("click", () => showScriptureVerse(r));
      scriptureResultsEl.appendChild(item);
    });
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
      currentScriptureIsLive = false;
      const content = scriptureContentForPart(currentScripture, parts, 0);
      stage("scripture", content);
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
    // A freshly picked search result is always a new selection - stage it
    // for preview/confirmation rather than assuming it should replace
    // whatever's currently live.
    currentScriptureIsLive = false;
    const content = scriptureContentForPart(currentScripture, parts, 0);
    stage("scripture", content);
    renderScriptureNav(content);
  }

  function renderScriptureNav(content) {
    scriptureNavEl.hidden = false;
    currentVerseLabelEl.textContent = `${content.reference} (${content.translation.toUpperCase()})`;
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
  function slideContentForPart(slide, parts, partIndex) {
    const label = parts.length > 1 ? `${slide.label} (${partIndex + 1}/${parts.length})` : slide.label;
    return { songTitle: currentSong.title, slideLabel: label, lines: parts[partIndex] };
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
    songDetailEl.hidden = false;
    songDetailTitleEl.textContent = currentSong.title;
    renderSlideList();
    if (!silent && currentSong.slides.length > 0) {
      selectSlide(0);
    }
  }

  document.getElementById("backToSongsBtn").addEventListener("click", () => {
    songDetailEl.hidden = true;
  });

  function renderSlideList() {
    slideListEl.innerHTML = "";
    (currentSong.slides || []).forEach((slide, idx) => {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "result-item slide-item" + (idx === currentSlideIndex ? " active" : "");
      item.innerHTML = `<div class="slide-label">${escapeHtml(slide.label)}</div><div class="slide-lines">${escapeHtml(slide.lines.join("\n"))}</div>`;
      item.addEventListener("click", () => selectSlide(idx));
      slideListEl.appendChild(item);
    });
    updateSlideNavLabel();
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

  // Selects slide `idx` fresh (always starting at its first part) and stages
  // or live-updates it depending on `live`.
  function applySlide(idx, live) {
    if (!currentSong || idx < 0 || idx >= currentSong.slides.length) return;
    currentSlideIndex = idx;
    const slide = currentSong.slides[idx];
    currentSlideParts = splitLinesIntoParts(slide.lines);
    currentSlidePartIndex = 0;
    const content = slideContentForPart(slide, currentSlideParts, 0);
    if (live) sendUpdate("lyric", content);
    else stage("lyric", content);
    renderSlideList();
  }

  // A direct click on a slide (or auto-opening a song's first slide) is
  // always a fresh selection - stage it for preview/confirmation.
  function selectSlide(idx) {
    currentLyricIsLive = false;
    applySlide(idx, false);
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
        songDetailEl.hidden = false;
        songDetailTitleEl.textContent = song.title;
        renderSlideList();
      })
      .catch(() => {});
  }

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
