// Parser for VideoPsalm's own native "Songbook" export - distinct from the
// OpenSong/ChordPro/plain-text interchange formats it can also produce.
//
// A VideoPsalm songbook is a JSON-like blob: either one songbook object
// directly ({ Guid, Text, Songs: [...] }), or a batch export - an array of
// { content: "<songbook JSON-ish string>" } entries, one per songbook. It is
// NOT strictly valid JSON as VideoPsalm writes it: object keys are often left
// unquoted (e.g. Guid:"...", Songs:[...]) and string fields can contain raw
// line breaks. repairSongbookJson() below normalizes that before JSON.parse.
//
// Ported from the open-source FreeShow project's working VideoPsalm importer
// (github.com/ChurchApps/FreeShow, src/frontend/converters/videopsalm.ts),
// which has been exercised against many real VideoPsalm exports across
// several bug reports/fixes in that project. Adapted here for a lyrics-only
// target (no chord-chart widget, no FreeShow slide/style model) - chords are
// stripped rather than kept as structured data. Not yet verified against a
// real export from this church's VideoPsalm installation/version - if an
// import doesn't come out clean, see README "Migrating your songs" and share
// a sample file so this can be tuned against the real thing.

const SECTION_WORDS = {
  v: "Verse",
  s: "Verse",
  c: "Chorus",
  r: "Chorus",
  p: "Pre-Chorus",
  b: "Bridge",
  t: "Tag",
  i: "Intro",
  o: "Outro",
  n: "Break",
};

// Fixed vocabulary of VideoPsalm's own field names. Only these are treated as
// unquoted object keys needing repair, so we never mis-quote a word that
// merely happens to appear inside real lyric/title text.
const KNOWN_KEYS = [
  "Guid", "IsCompressed", "IsSearchable", "VersionDate", "Text", "ID",
  "Reference", "Verses", "Tag", "Style", "Sequence", "VideoDuration",
  "VerseOrderIndex", "Composer", "Author", "Copyright", "CCLI", "Theme",
  "AudioFile", "Memo1", "Memo2", "Memo3", "Songs", "Abbreviation", "content",
];
const KEY_RE = new RegExp(`([{,]\\s*)(${KNOWN_KEYS.join("|")})(\\s*:)`, "g");

// ---- JSON repair -----------------------------------------------------------

function repairSongbookJson(raw) {
  let text = String(raw);

  // Raw line breaks inside a JSON string are invalid JSON - fold them into a
  // "<br>" marker instead (recovered back into real line breaks once we're
  // working with the parsed string values, in linesFromVerseText below).
  text = text
    .replace(/\{\r?\n/g, "{")
    .replace(/\}\r?\n/g, "}")
    .replace(/\r?\n/g, "<br>")
    .replace(/[\t\v\r\f﻿]/g, "")
    .replace(/,<br>"/g, ',"');

  text = text.replace(KEY_RE, '$1"$2"$3');

  return text;
}

// JSON.parse with one bounded auto-fix retry loop: on a parse error, try
// quoting whatever bareword sits at the failure position (catches unquoted
// keys outside the KNOWN_KEYS vocabulary), then retry. Gives up (throws) once
// a retry lands on the same error position twice, rather than looping forever
// on content that isn't fixable this way.
function parseWithAutoFix(text, previousErrorPos) {
  try {
    return JSON.parse(text || "{}");
  } catch (err) {
    const match = /position (\d+)/.exec(String(err.message));
    const pos = match ? Number(match[1]) : null;
    if (pos == null || pos === previousErrorPos) throw err;

    const start = text.slice(0, pos);
    const wordEnd = text.indexOf(":", pos);
    if (wordEnd < 0) throw err;
    const word = text.slice(pos, wordEnd);
    if (!/^[A-Za-z_]\w*$/.test(word)) throw err; // not a safe/plausible bareword key

    const end = text.slice(wordEnd);
    return parseWithAutoFix(`${start}"${word}"${end}`, pos);
  }
}

function parseSongbookJson(raw) {
  // Try a clean parse first - some exports (and anything hand-formatted) are
  // already valid JSON, and repairSongbookJson's newline-folding assumes
  // *every* raw line break is an embedded one inside a string value, which
  // would corrupt ordinary pretty-printed JSON if applied unconditionally.
  try {
    return JSON.parse(raw);
  } catch {
    return parseWithAutoFix(repairSongbookJson(raw));
  }
}

// ---- Text/line handling -----------------------------------------------------

// Chord annotations embedded in verse text, e.g. "Amazing [C]grace". Short
// bracket contents with no "x" (chord names like "[Gm]", "[F#m7]") are
// stripped, since this is a lyrics-only display with no chord chart. Longer
// or "x"-containing brackets (repeat markers like "[x4]", or "[Interlude]")
// are left as visible text - same heuristic as the FreeShow reference.
function stripChords(text) {
  return text.replace(/\[([^\]]*)\]/g, (whole, inner) => {
    if (inner.length > 0 && inner.length <= 5 && !/x/i.test(inner)) return "";
    return whole;
  });
}

function cleanLine(text) {
  return stripChords(text)
    .replace(/<\/?f[^>]*>/gi, "") // font-tag artifacts VideoPsalm embeds in its rich text
    .trim();
}

function linesFromVerseText(rawText) {
  return String(rawText || "")
    .split(/<br\s*\/?>/i)
    .map(cleanLine)
    .filter(Boolean);
}

// ---- Sequence -> label mapping -----------------------------------------------

// Sequence is a space-separated presentation order like "V1 C V2 C B1", each
// token positionally paired with the same-index entry in Verses. Falls back
// to a plain numbered "Verse N" when a song has no Sequence (or a verse has
// no corresponding token) - same convention as the other format parsers.
function labelForToken(token, counters) {
  const match = token ? String(token).match(/^([A-Za-z]+)(\d*)$/) : null;
  const letter = match ? match[1][0].toLowerCase() : "v";
  const word = SECTION_WORDS[letter] || "Verse";
  const explicitNum = match ? match[2] : "";
  if (explicitNum) return `${word} ${explicitNum}`;
  counters[word] = (counters[word] || 0) + 1;
  return word === "Verse" || counters[word] > 1 ? `${word} ${counters[word]}` : word;
}

function slidesFromSong(song) {
  const verses = Array.isArray(song.Verses) ? song.Verses : [];
  const sequence = typeof song.Sequence === "string" ? song.Sequence.trim().split(/\s+/).filter(Boolean) : [];
  const counters = {};

  const slides = [];
  verses.forEach((verse, i) => {
    const lines = linesFromVerseText(verse && verse.Text);
    if (lines.length === 0) return;
    slides.push({ label: labelForToken(sequence[i], counters), lines });
  });
  return slides;
}

// ---- Song/songbook extraction -------------------------------------------------

function songFromRaw(rawSong) {
  const title = String((rawSong && rawSong.Text) || "")
    .replace(/<br\s*\/?>/gi, " ")
    .trim();
  return { title, slides: slidesFromSong(rawSong || {}) };
}

// Detects/unwraps the two shapes VideoPsalm can export: a single songbook
// object, or a batch array of { content: "<songbook JSON-ish string>" }
// entries (one per songbook).
function songbooksFromParsed(parsed) {
  if (Array.isArray(parsed)) {
    return parsed
      .map((entry) => {
        if (entry && typeof entry.content === "string" && entry.content.trim()) {
          try {
            return parseSongbookJson(entry.content);
          } catch {
            return null;
          }
        }
        return entry && Array.isArray(entry.Songs) ? entry : null;
      })
      .filter(Boolean);
  }
  return parsed && Array.isArray(parsed.Songs) ? [parsed] : [];
}

/**
 * Parses a VideoPsalm songbook export. A songbook file can contain an entire
 * library, so - unlike the single-song opensong/chordpro/plaintext parsers -
 * this returns an array of { title, slides }, one per song.
 */
function parseVideoPsalmSongbook(fileContents) {
  let parsed;
  try {
    parsed = parseSongbookJson(fileContents);
  } catch (err) {
    throw new Error(`VideoPsalm songbook is not valid/repairable JSON: ${err.message}`);
  }

  const songbooks = songbooksFromParsed(parsed);
  if (songbooks.length === 0) {
    throw new Error("VideoPsalm songbook JSON doesn't contain a recognizable Songs list");
  }

  const songs = [];
  for (const book of songbooks) {
    for (const rawSong of Array.isArray(book.Songs) ? book.Songs : []) {
      const song = songFromRaw(rawSong);
      if (song.title && song.slides.length > 0) songs.push(song);
    }
  }

  if (songs.length === 0) {
    throw new Error("VideoPsalm songbook JSON parsed but contained no usable songs");
  }

  return songs;
}

// Cheap pre-parse sniff used by detectFormat - true if the raw text looks
// like it could be a VideoPsalm songbook, without attempting the (more
// expensive, and only valid on real matches) repair+parse.
function looksLikeVideoPsalmSongbook(text) {
  const trimmed = text.trim();
  if (!(trimmed.startsWith("{") || trimmed.startsWith("["))) return false;
  return /"?Songs"?\s*:/.test(trimmed) && /"?Verses"?\s*:/.test(trimmed);
}

module.exports = { parseVideoPsalmSongbook, looksLikeVideoPsalmSongbook };
