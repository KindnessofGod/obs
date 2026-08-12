const path = require("path");
const fs = require("fs");
const express = require("express");
const multer = require("multer");
const { WebSocketServer } = require("ws");

const bible = require("./lib/bible");
const migration = require("./lib/migration");

const PORT = process.env.PORT || 3210;
const DATA_DIR = path.join(__dirname, "..", "data");
const SONGS_DIR = path.join(DATA_DIR, "songs");
const ANNOUNCEMENTS_FILE = path.join(DATA_DIR, "announcements", "announcements.json");
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

app.get("/api/songs/:id", (req, res) => {
  const file = path.join(SONGS_DIR, `${req.params.id}.json`);
  // req.params.id is decoded by Express *after* route matching, so an id like
  // "..%2f..%2fpackage" (percent-encoded, matches as a single path segment)
  // decodes to "../../package" and can escape SONGS_DIR via path.join. Guard
  // against that path traversal by rejecting anything that resolves outside it.
  if (!file.startsWith(SONGS_DIR + path.sep)) return res.status(400).json({ error: "invalid song id" });
  if (!fs.existsSync(file)) return res.status(404).json({ error: "song not found" });
  res.json(JSON.parse(fs.readFileSync(file, "utf8")));
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

function sanitizeLayout(raw) {
  const layout = {};
  for (const field of LAYOUT_FIELDS) {
    if (raw && typeof raw[field] === "number" && isFinite(raw[field])) {
      layout[field] = Math.min(LAYOUT_PCT_MAX, Math.max(LAYOUT_PCT_MIN, raw[field]));
    }
  }
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
