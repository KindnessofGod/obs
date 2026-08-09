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

const SONGS_DIR = path.join(__dirname, "..", "..", "..", "data", "songs");

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
 * -> "opensong" | "chordpro" | "plaintext" | "unknown"
 */
function detectFormat(fileContents, filename) {
  if (typeof fileContents !== "string") return "unknown";
  const text = fileContents.trim();
  if (!text) return "unknown";

  const ext = filename ? path.extname(String(filename)).toLowerCase() : "";

  // XML declaration or a <song> root -> OpenSong, provided it actually has the
  // shape we can parse. Any other XML-ish content is something we don't support.
  if (/^<\?xml/i.test(text) || /^<song[\s>]/i.test(text)) {
    return /<song[\s>][\s\S]*<\/song>/i.test(text) ? "opensong" : "unknown";
  }
  if (text.startsWith("<")) return "unknown";

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
        `Cannot parse song: unrecognized format "${format}". Expected one of "opensong", "chordpro", "plaintext".`
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

function uniqueId(baseId, takenIds) {
  if (!takenIds.has(baseId)) return baseId;
  let n = 2;
  while (takenIds.has(`${baseId}-${n}`)) n++;
  return `${baseId}-${n}`;
}

/**
 * Parses every file in dirPath and writes data/songs/<id>.json for each one that
 * parses successfully. Never throws on a per-file problem - those are collected in
 * `errors` so one bad file doesn't abort the whole batch.
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

  if (!fs.existsSync(SONGS_DIR)) {
    fs.mkdirSync(SONGS_DIR, { recursive: true });
  }

  const takenIds = new Set(
    fs
      .readdirSync(SONGS_DIR)
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.slice(0, -".json".length))
  );

  for (const file of files) {
    const filePath = path.join(dirPath, file);
    try {
      const contents = await fs.promises.readFile(filePath, "utf8");
      const format = detectFormat(contents, file);
      const song = parseSong(contents, format);

      const id = uniqueId(song.id, takenIds);
      takenIds.add(id);

      const output = { id, title: song.title, slides: song.slides };
      fs.writeFileSync(path.join(SONGS_DIR, `${id}.json`), JSON.stringify(output, null, 2));
      imported.push(id);
    } catch (err) {
      errors.push({ file, reason: err.message });
    }
  }

  return { imported, errors };
}

module.exports = { detectFormat, parseSong, importSongsFromDir };
