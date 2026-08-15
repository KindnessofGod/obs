const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const express = require("express");
const multer = require("multer");
const { WebSocketServer } = require("ws");

const bible = require("./lib/bible");
const migration = require("./lib/migration");

const PORT = process.env.PORT || 3210;
const DATA_DIR = path.join(__dirname, "..", "data");
const SONGS_DIR = path.join(DATA_DIR, "songs");
const ANNOUNCEMENTS_FILE = path.join(DATA_DIR, "announcements", "announcements.json");
const SCRIPTURE_BOOKMARKS_FILE = path.join(DATA_DIR, "scripture-bookmarks", "bookmarks.json");
const SETLIST_FILE = path.join(DATA_DIR, "setlist.json");
const BACKGROUNDS_DIR = path.join(DATA_DIR, "backgrounds");

const app = express();
app.use(express.json());
app.use("/display", express.static(path.join(__dirname, "..", "public", "display")));
app.use("/control", express.static(path.join(__dirname, "..", "public", "control")));
app.use("/backgrounds", express.static(BACKGROUNDS_DIR));

// ---- Bible ----

app.get("/api/bible/translations", (req, res) => {
  res.json(bible.listTranslations());
});

app.get("/api/bible/search", (req, res) => {
  const q = String(req.query.q || "").trim();
  const translationIds = String(req.query.translations || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  // bookMatch: set once the query unambiguously names a book (e.g. "josh"),
  // even before it's typed out into a full reference - /control uses this to
  // auto-jump straight to that book's chapter 1 for speed.
  const bookMatch = bible.resolveUniqueBookPrefix(q);
  if (!q || translationIds.length === 0) return res.json({ results: [], bookMatch });
  res.json({ results: bible.searchOffline(q, translationIds), bookMatch });
});

app.get("/api/bible/verse", async (req, res) => {
  const { translation, book, chapter, verse } = req.query;
  if (!translation || !book || !chapter || !verse) {
    return res.status(400).json({ error: "translation, book, chapter, verse are required" });
  }
  try {
    const result = await bible.getVerse(translation, book, Number(chapter), Number(verse));
    if (!result) return res.status(404).json({ error: "verse not found" });
    res.json(result);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ---- Songs ----

function readSongIndex() {
  if (!fs.existsSync(SONGS_DIR)) return [];
  return fs
    .readdirSync(SONGS_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      const song = JSON.parse(fs.readFileSync(path.join(SONGS_DIR, f), "utf8"));
      return { id: song.id, title: song.title };
    });
}

app.get("/api/songs", (req, res) => {
  res.json(readSongIndex());
});

// req.params.id is decoded by Express *after* route matching, so an id like
// "..%2f..%2fpackage" (percent-encoded, matches as a single path segment)
// decodes to "../../package" and can escape SONGS_DIR via path.join. Guard
// against that path traversal by rejecting anything that resolves outside it.
function songFilePath(id) {
  const file = path.join(SONGS_DIR, `${id}.json`);
  return file.startsWith(SONGS_DIR + path.sep) ? file : null;
}

function isValidSlides(slides) {
  return (
    Array.isArray(slides) &&
    slides.every(
      (s) =>
        s &&
        typeof s === "object" &&
        typeof s.label === "string" &&
        Array.isArray(s.lines) &&
        s.lines.every((l) => typeof l === "string")
    )
  );
}

app.get("/api/songs/:id", (req, res) => {
  const file = songFilePath(req.params.id);
  if (!file) return res.status(400).json({ error: "invalid song id" });
  if (!fs.existsSync(file)) return res.status(404).json({ error: "song not found" });
  res.json(JSON.parse(fs.readFileSync(file, "utf8")));
});

app.put("/api/songs/:id", (req, res) => {
  const file = songFilePath(req.params.id);
  if (!file) return res.status(400).json({ error: "invalid song id" });
  if (!fs.existsSync(file)) return res.status(404).json({ error: "song not found" });
  const { title, slides } = req.body || {};
  if (typeof title !== "string" || !title.trim()) return res.status(400).json({ error: "title is required" });
  if (!isValidSlides(slides)) {
    return res.status(400).json({ error: "slides must be an array of { label: string, lines: string[] }" });
  }
  // id is intentionally NOT re-derived from the (possibly edited) title -
  // it stays stable across edits so existing references (saved scriptures
  // don't apply here, but the song's own file/URL) never change underfoot.
  const song = { id: req.params.id, title: title.trim(), slides };
  fs.writeFileSync(file, JSON.stringify(song, null, 2));
  res.json(song);
});

app.delete("/api/songs/:id", (req, res) => {
  const file = songFilePath(req.params.id);
  if (!file) return res.status(400).json({ error: "invalid song id" });
  if (!fs.existsSync(file)) return res.status(404).json({ error: "song not found" });
  fs.unlinkSync(file);
  res.json({ ok: true });
});

const upload = multer({
  dest: path.join(DATA_DIR, "uploads"),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB - generous for a song file, bounds a runaway upload
});
app.post("/api/songs/import", upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "file is required" });
  try {
    // readSongFileText transparently extracts a compressed VideoPsalm .vpc
    // (a ZIP) into plain text first; anything else just gets read as-is.
    const { text, filename } = await migration.readSongFileText(req.file.path, req.file.originalname);
    const format = migration.detectFormat(text, filename);
    // A single file can hold many songs (e.g. a whole VideoPsalm songbook), so
    // this parses/writes a list rather than assuming one song per upload.
    const songs = migration.parseSongs(text, format);
    const imported = migration.writeSongs(songs, migration.loadExistingSongIds());
    res.json({ imported, errors: [] });
  } catch (err) {
    res.status(422).json({ imported: [], errors: [{ file: req.file.originalname, reason: err.message }] });
  } finally {
    fs.unlink(req.file.path, () => {});
  }
});

// ---- Setlist ----
// A single ordered list of song ids, prepared ahead of a service so the
// operator can click straight through it instead of searching for each
// song live. Deliberately just an ordered array, not per-slide-type or
// timestamped - one "today's plan" at a time, replaced wholesale on each save.

app.get("/api/setlist", (req, res) => {
  if (!fs.existsSync(SETLIST_FILE)) return res.json({ songIds: [] });
  res.json(JSON.parse(fs.readFileSync(SETLIST_FILE, "utf8")));
});

app.put("/api/setlist", (req, res) => {
  const { songIds } = req.body || {};
  if (!Array.isArray(songIds) || !songIds.every((id) => typeof id === "string")) {
    return res.status(400).json({ error: "songIds must be an array of strings" });
  }
  // Drop any id that no longer resolves to a real song (e.g. deleted via the
  // song editor since being added to the setlist), so the list can't
  // silently accumulate dead entries.
  const existingIds = migration.loadExistingSongIds();
  const cleaned = songIds.filter((id) => existingIds.has(id));
  const dir = path.dirname(SETLIST_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const result = { songIds: cleaned };
  fs.writeFileSync(SETLIST_FILE, JSON.stringify(result, null, 2));
  res.json(result);
});

// ---- Announcements ----

app.get("/api/announcements", (req, res) => {
  if (!fs.existsSync(ANNOUNCEMENTS_FILE)) return res.json([]);
  res.json(JSON.parse(fs.readFileSync(ANNOUNCEMENTS_FILE, "utf8")));
});

app.post("/api/announcements", (req, res) => {
  const { title, body } = req.body || {};
  if (!title) return res.status(400).json({ error: "title is required" });
  const dir = path.dirname(ANNOUNCEMENTS_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const list = fs.existsSync(ANNOUNCEMENTS_FILE) ? JSON.parse(fs.readFileSync(ANNOUNCEMENTS_FILE, "utf8")) : [];
  list.push({ title, body: body || "" });
  fs.writeFileSync(ANNOUNCEMENTS_FILE, JSON.stringify(list, null, 2));
  res.json(list);
});

// ---- Saved scripture references ----
// Lets the operator bookmark a verse (e.g. the anchor verse of today's
// sermon) and recall it with one click later in the service, without
// disturbing whatever's currently staged/live - distinct from search
// history, which isn't persisted at all.

app.get("/api/scripture-bookmarks", (req, res) => {
  if (!fs.existsSync(SCRIPTURE_BOOKMARKS_FILE)) return res.json([]);
  res.json(JSON.parse(fs.readFileSync(SCRIPTURE_BOOKMARKS_FILE, "utf8")));
});

app.post("/api/scripture-bookmarks", (req, res) => {
  const { book, chapter, verse, translation } = req.body || {};
  if (!book || !chapter || !verse || !translation) {
    return res.status(400).json({ error: "book, chapter, verse, translation are required" });
  }
  const dir = path.dirname(SCRIPTURE_BOOKMARKS_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const list = fs.existsSync(SCRIPTURE_BOOKMARKS_FILE)
    ? JSON.parse(fs.readFileSync(SCRIPTURE_BOOKMARKS_FILE, "utf8"))
    : [];
  const entry = {
    id: crypto.randomUUID(),
    book: String(book),
    chapter: Number(chapter),
    verse: Number(verse),
    translation: String(translation),
  };
  list.push(entry);
  fs.writeFileSync(SCRIPTURE_BOOKMARKS_FILE, JSON.stringify(list, null, 2));
  res.json(list);
});

app.delete("/api/scripture-bookmarks/:id", (req, res) => {
  if (!fs.existsSync(SCRIPTURE_BOOKMARKS_FILE)) return res.json([]);
  const list = JSON.parse(fs.readFileSync(SCRIPTURE_BOOKMARKS_FILE, "utf8"));
  const next = list.filter((b) => b.id !== req.params.id);
  fs.writeFileSync(SCRIPTURE_BOOKMARKS_FILE, JSON.stringify(next, null, 2));
  res.json(next);
});

// ---- Config (non-secret only) ----

const BACKGROUND_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".mp4", ".webm", ".mov"]);

app.get("/api/config", (req, res) => {
  const backgrounds = fs.existsSync(BACKGROUNDS_DIR)
    ? fs.readdirSync(BACKGROUNDS_DIR).filter((f) => BACKGROUND_EXTENSIONS.has(path.extname(f).toLowerCase()))
    : [];
  res.json({ backgrounds });
});

const server = app.listen(PORT, () => {
  console.log(`Church presenter running: control http://localhost:${PORT}/control  display http://localhost:${PORT}/display`);
});

// ---- WebSocket sync ----

const wss = new WebSocketServer({ server, path: "/ws" });

const TEXT_SCALE_MIN = 0.7;
const TEXT_SCALE_MAX = 1.6;
const LAYOUT_PCT_MIN = 5;
const LAYOUT_PCT_MAX = 200;
const LAYOUT_FIELDS = ["bgWidthPct", "bgHeightPct", "textWidthPct", "textHeightPct"];
const TEXT_ALIGN_VALUES = new Set(["top", "middle", "bottom"]);
const TEXT_HALIGN_VALUES = new Set(["left", "center", "right"]);
const FONT_FAMILY_VALUES = new Set(["default", "serif", "sans", "condensed", "rounded"]);

function sanitizeLayout(raw) {
  const layout = {};
  for (const field of LAYOUT_FIELDS) {
    if (raw && typeof raw[field] === "number" && isFinite(raw[field])) {
      layout[field] = Math.min(LAYOUT_PCT_MAX, Math.max(LAYOUT_PCT_MIN, raw[field]));
    }
  }
  if (raw && TEXT_ALIGN_VALUES.has(raw.textAlign)) layout.textAlign = raw.textAlign;
  if (raw && TEXT_HALIGN_VALUES.has(raw.textHAlign)) layout.textHAlign = raw.textHAlign;
  if (raw && FONT_FAMILY_VALUES.has(raw.fontFamily)) layout.fontFamily = raw.fontFamily;
  if (raw && typeof raw.bold === "boolean") layout.bold = raw.bold;
  if (raw && typeof raw.allCaps === "boolean") layout.allCaps = raw.allCaps;
  return layout;
}

let state = { visible: false, current: null, textScale: 1, layout: {} };

function broadcast(message) {
  const payload = JSON.stringify(message);
  for (const client of wss.clients) {
    if (client.readyState === client.OPEN) client.send(payload);
  }
}

wss.on("connection", (ws) => {
  ws.send(
    JSON.stringify({
      type: "state",
      visible: state.visible,
      current: state.current,
      textScale: state.textScale,
      layout: state.layout,
    })
  );

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.type === "show" && msg.slideType && msg.content) {
      state = {
        visible: true,
        current: { slideType: msg.slideType, content: msg.content },
        textScale: state.textScale,
        layout: state.layout,
      };
      broadcast({ type: "show", slideType: msg.slideType, content: msg.content });
    } else if (msg.type === "update" && msg.content && state.current) {
      state.current.content = msg.content;
      broadcast({ type: "update", content: msg.content });
    } else if (msg.type === "hide") {
      state = { visible: false, current: state.current, textScale: state.textScale, layout: state.layout };
      broadcast({ type: "hide" });
    } else if (msg.type === "textScale" && typeof msg.scale === "number") {
      state.textScale = Math.min(TEXT_SCALE_MAX, Math.max(TEXT_SCALE_MIN, msg.scale));
      broadcast({ type: "textScale", scale: state.textScale });
    } else if (msg.type === "layout" && msg.layout && typeof msg.layout === "object") {
      state.layout = sanitizeLayout(msg.layout);
      broadcast({ type: "layout", layout: state.layout });
    }
  });
});

bible.init().catch((err) => {
  console.error("Bible data layer failed to initialize:", err.message);
});
