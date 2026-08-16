// server/lib/migration/index.js
//
// VideoPsalm import tooling. Per PROTOCOL.md, VideoPsalm's own documented import
// paths are: OpenSong-compatible XML, ChordPro, and plain "text formatted" songs -
// there is no proprietary VideoPsalm file format we need to reverse engineer here,
// since the church is expected to use VideoPsalm's own export/import wizard to get
// their library into one of these three interchange formats first.

const fs = require("fs");
const path = require("path");

const { slugify } = require("./lib/slugify");
const { parseOpenSong } = require("./lib/opensong");
const { parseChordPro } = require("./lib/chordpro");
const { parsePlainText } = require("./lib/plaintext");
const { parseVideoPsalmSongbook, looksLikeVideoPsalmSongbook } = require("./lib/videopsalm");
const { readZipEntries } = require("./lib/zip");

// Default target is the real data/songs directory, as PROTOCOL.md specifies.
// Overridable via MIGRATION_SONGS_DIR so the fixtures self-test (and any other
// tooling) can exercise importSongsFromDir without writing into the app's real
// song library - importSongsFromDir's public signature/behavior is unaffected.
function songsDir() {
  return process.env.MIGRATION_SONGS_DIR
    ? path.resolve(process.env.MIGRATION_SONGS_DIR)
    : path.join(__dirname, "..", "..", "..", "data", "songs");
}

// Directive names recognized as ChordPro section/metadata directives (used for
// content sniffing in detectFormat). Kept in sync with lib/chordpro.js's directive
// vocabulary, plus a few common metadata-only directives that don't affect parsing
// but are still strong evidence a file is ChordPro.
const CHORDPRO_DIRECTIVE_NAMES = [
  "title",
  "t",
  "subtitle",
  "st",
  "artist",
  "composer",
  "key",
  "capo",
  "tempo",
  "time",
  "duration",
  "comment",
  "c",
  "meta",
  "start_of_chorus",
  "soc",
  "end_of_chorus",
  "eoc",
  "start_of_verse",
  "sov",
  "end_of_verse",
  "eov",
  "start_of_bridge",
  "sob",
  "end_of_bridge",
  "eob",
  "start_of_tab",
  "sot",
  "end_of_tab",
  "eot",
];
const CHORDPRO_DIRECTIVE_RE = new RegExp(
  `\\{\\s*(?:${CHORDPRO_DIRECTIVE_NAMES.join("|")})\\b[^}]*\\}`,
  "i"
);
const CHORDPRO_EXTENSIONS = new Set([".cho", ".chordpro", ".chopro", ".crd", ".pro"]);

/**
 * Sniffs a song file's format from its content (and, secondarily, its filename).
 * Expects `fileContents` to already be plain text - a .vpc file's binary ZIP
 * bytes must be extracted first via readSongFileText, which is what
 * importSongsFromDir/the upload route actually call.
 * -> "opensong" | "chordpro" | "plaintext" | "videopsalm" | "unknown"
 */
function detectFormat(fileContents, filename) {
  if (typeof fileContents !== "string") return "unknown";
  const text = fileContents.trim();

  const ext = filename ? path.extname(String(filename)).toLowerCase() : "";

  if (!text) return "unknown";

  // XML declaration or a <song> root -> OpenSong, provided it actually has the
  // shape we can parse. Any other XML-ish content is something we don't support.
  if (/^<\?xml/i.test(text) || /^<song[\s>]/i.test(text)) {
    return /<song[\s>][\s\S]*<\/song>/i.test(text) ? "opensong" : "unknown";
  }
  if (text.startsWith("<")) return "unknown";

  if (looksLikeVideoPsalmSongbook(text)) return "videopsalm";

  if (CHORDPRO_DIRECTIVE_RE.test(text) || CHORDPRO_EXTENSIONS.has(ext)) {
    return "chordpro";
  }

  return "plaintext";
}

/**
 * Parses song file contents of a known format into { title, slides }.
 * Also attaches an `id` (slug of the title) since server/index.js's
 * POST /api/songs/import route writes `${song.id}.json` straight from this result.
 */
function parseSong(fileContents, format) {
  let parsed;
  switch (format) {
    case "opensong":
      parsed = parseOpenSong(fileContents);
      break;
    case "chordpro":
      parsed = parseChordPro(fileContents);
      break;
    case "plaintext":
      parsed = parsePlainText(fileContents);
      break;
    case "unknown":
    case undefined:
    case null:
      throw new Error(
        `Cannot parse song: unrecognized format "${format}". Expected one of "opensong", "chordpro", "plaintext", "videopsalm".`
      );
    default:
      throw new Error(`Cannot parse song: unsupported format "${format}".`);
  }

  return {
    id: slugify(parsed.title),
    title: parsed.title,
    slides: parsed.slides,
  };
}

/**
 * Like parseSong, but for any format - including VideoPsalm's native songbook
 * format, where a single file can hold an entire library. Always returns an
 * array of { id, title, slides }: length 1 for the single-song formats,
 * potentially many for "videopsalm".
 */
function parseSongs(fileContents, format) {
  if (format === "videopsalm") {
    return parseVideoPsalmSongbook(fileContents).map((song) => ({
      id: slugify(song.title),
      title: song.title,
      slides: song.slides,
    }));
  }
  return [parseSong(fileContents, format)];
}

// ZIP local-file-header magic ("PK\x03\x04") / empty-archive magic
// ("PK\x05\x06"), sniffed from the file's actual bytes rather than trusting
// its extension - VideoPsalm's "Compressed" Songbook export is a plain ZIP,
// but export tooling doesn't always give it a .vpc extension (a real church
// export showed up here saved as plain .json while still being raw ZIP
// bytes), which silently corrupted the import by reading the archive as text.
const ZIP_MAGIC_PREFIXES = [
  Buffer.from([0x50, 0x4b, 0x03, 0x04]),
  Buffer.from([0x50, 0x4b, 0x05, 0x06]),
];

function looksLikeZip(buffer) {
  return buffer.length >= 4 && ZIP_MAGIC_PREFIXES.some((magic) => buffer.subarray(0, 4).equals(magic));
}

/**
 * Reads a song file as text, transparently extracting VideoPsalm's compressed
 * .vpc export (a plain ZIP containing one JSON entry) first if that's what
 * it is - detected from the file's own bytes, not its extension (see
 * looksLikeZip). Returns { text, filename } - filename is the original for a
 * normal text file, or the inner ZIP entry's name for a ZIP export (so
 * detectFormat sees the real underlying file, not the outer archive's name).
 */
async function readSongFileText(filePath, filename) {
  const buffer = await fs.promises.readFile(filePath);
  const ext = path.extname(String(filename || filePath)).toLowerCase();

  if (!looksLikeZip(buffer)) {
    // A file explicitly named .vpc that isn't actually ZIP content is almost
    // certainly a corrupted/truncated export, not a genuine plain-text song -
    // worth a clear, specific error rather than silently misreading it as text.
    if (ext === ".vpc") {
      throw new Error(
        `Could not open this as a VideoPsalm compressed songbook (.vpc): the file doesn't look like a valid ZIP archive. If this isn't a real VideoPsalm export, or came from a very different version, try re-exporting with "Compressed" unchecked so it saves as a plain .json instead.`
      );
    }
    return { text: buffer.toString("utf8"), filename };
  }

  let entries;
  try {
    entries = readZipEntries(buffer);
  } catch (err) {
    throw new Error(
      `Could not open this as a VideoPsalm compressed songbook (.vpc): ${err.message}. If this isn't a real VideoPsalm export, or came from a very different version, try re-exporting with "Compressed" unchecked so it saves as a plain .json instead.`
    );
  }
  const jsonEntry = entries.find((e) => /\.json$/i.test(e.name)) || entries[0];
  if (!jsonEntry) throw new Error("This .vpc archive doesn't contain any files.");
  return { text: jsonEntry.data.toString("utf8"), filename: jsonEntry.name };
}

function uniqueId(baseId, takenIds) {
  if (!takenIds.has(baseId)) return baseId;
  let n = 2;
  while (takenIds.has(`${baseId}-${n}`)) n++;
  return `${baseId}-${n}`;
}

function loadExistingSongIds() {
  const SONGS_DIR = songsDir();
  if (!fs.existsSync(SONGS_DIR)) return new Set();
  return new Set(
    fs
      .readdirSync(SONGS_DIR)
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.slice(0, -".json".length))
  );
}

/**
 * Writes each of `songs` (as returned by parseSongs) to data/songs/<id>.json,
 * de-duplicating against `takenIds` (mutated in place as ids are claimed, so
 * repeated calls - e.g. one per file in a batch import - never collide with
 * each other or with what's already on disk). -> [...ids written]
 */
function writeSongs(songs, takenIds) {
  const SONGS_DIR = songsDir();
  if (!fs.existsSync(SONGS_DIR)) fs.mkdirSync(SONGS_DIR, { recursive: true });

  const written = [];
  for (const song of songs) {
    const id = uniqueId(song.id, takenIds);
    takenIds.add(id);
    const output = { id, title: song.title, slides: song.slides };
    fs.writeFileSync(path.join(SONGS_DIR, `${id}.json`), JSON.stringify(output, null, 2));
    written.push(id);
  }
  return written;
}

/**
 * Parses every file in dirPath and writes data/songs/<id>.json for each song
 * found (a VideoPsalm songbook file can yield many). Never throws on a
 * per-file problem - those are collected in `errors` so one bad file doesn't
 * abort the whole batch.
 * -> { imported: [...ids], errors: [{file, reason}] }
 */
async function importSongsFromDir(dirPath) {
  const imported = [];
  const errors = [];

  let entries;
  try {
    entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
  } catch (err) {
    return { imported, errors: [{ file: dirPath, reason: `Could not read directory: ${err.message}` }] };
  }

  const files = entries
    .filter((entry) => entry.isFile() && !entry.name.startsWith("."))
    .map((entry) => entry.name)
    .sort();

  const takenIds = loadExistingSongIds();

  for (const file of files) {
    const filePath = path.join(dirPath, file);
    try {
      const { text, filename } = await readSongFileText(filePath, file);
      const format = detectFormat(text, filename);
      const songs = parseSongs(text, format);
      imported.push(...writeSongs(songs, takenIds));
    } catch (err) {
      errors.push({ file, reason: err.message });
    }
  }

  return { imported, errors };
}

module.exports = {
  detectFormat,
  parseSong,
  parseSongs,
  writeSongs,
  loadExistingSongIds,
  readSongFileText,
  importSongsFromDir,
  slugify,
  uniqueId,
};
