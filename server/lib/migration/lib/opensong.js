// Parser for OpenSong's XML song format.
//
// Verified against real OpenSong export files (e.g. joshaw/OpenSong on GitHub,
// https://raw.githubusercontent.com/joshaw/OpenSong/master/Songs/Here%20I%20Am%20To%20Worship),
// which confirmed:
//   - Files use CRLF line endings and a flat <song>...</song> root with sibling tags
//     <title>, <author>, <copyright>, <presentation>, <ccli>, <theme>, <lyrics>, etc.
//   - The <lyrics> element holds plain text (not nested XML): section markers like
//     [V1], [C], [V2], [B] sit on their own line; chord lines are prefixed with a
//     leading "." and are positioned above the lyric line they annotate; blank
//     (or whitespace-only) lines separate blocks.
// We deliberately avoid pulling in an XML parsing dependency: OpenSong's tags are
// flat and non-nested, so a small tolerant regex extractor is sufficient and keeps
// this migration tool dependency-free.

const SECTION_WORDS = {
  v: "Verse",
  c: "Chorus",
  b: "Bridge",
  p: "Pre-Chorus",
  pc: "Pre-Chorus",
  t: "Tag",
  i: "Intro",
  o: "Outro",
  e: "Ending",
};

function decodeXmlEntities(str) {
  return String(str)
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&amp;/g, "&"); // must run last so we don't double-decode "&amp;lt;" etc.
}

function extractXmlTag(xml, tag) {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "i");
  const match = xml.match(re);
  return match ? match[1] : null;
}

// Maps a raw OpenSong section marker (the text inside "[...]", e.g. "V1", "C", "B2")
// to a readable slide label, e.g. "Verse 1", "Chorus", "Bridge 2".
function labelForSection(rawMarker) {
  const marker = String(rawMarker).trim();
  const match = marker.match(/^([A-Za-z]+)\s*(\d*)$/);
  if (match) {
    const word = SECTION_WORDS[match[1].toLowerCase()];
    const num = match[2];
    if (word) return num ? `${word} ${num}` : word;
  }
  // Unknown/custom marker (e.g. "[Interlude]") - just title-case it as-is.
  return marker.replace(/\w\S*/g, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase());
}

function slidesFromLyrics(lyrics) {
  const lines = lyrics.split("\n");
  const slides = [];
  let current = null;
  let verseCounter = 0;

  const flush = () => {
    if (current && current.lines.length) slides.push(current);
    current = null;
  };

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    const sectionMatch = trimmed.match(/^\[([^\]]+)\]$/);

    if (sectionMatch) {
      flush();
      current = { label: labelForSection(sectionMatch[1]), lines: [] };
      continue;
    }
    if (rawLine.startsWith(".")) {
      // Chord line (chords positioned above the lyric line) - not lyric content, skip.
      continue;
    }
    if (!trimmed) {
      // Blank/whitespace-only line: separator between blocks (used both between
      // labelled sections, and to delimit blocks in files with no section markers).
      flush();
      continue;
    }
    if (!current) {
      verseCounter += 1;
      current = { label: `Verse ${verseCounter}`, lines: [] };
    }
    current.lines.push(trimmed);
  }
  flush();

  return slides;
}

function parseOpenSong(fileContents) {
  const normalized = String(fileContents).replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  if (!/<song[\s>]/i.test(normalized)) {
    throw new Error("OpenSong XML is missing the <song> root element");
  }

  const rawTitle = extractXmlTag(normalized, "title");
  if (!rawTitle || !rawTitle.trim()) {
    throw new Error("OpenSong XML is missing a <title> element");
  }
  const title = decodeXmlEntities(rawTitle).trim();

  const rawLyrics = extractXmlTag(normalized, "lyrics");
  if (rawLyrics == null) {
    throw new Error("OpenSong XML is missing a <lyrics> element");
  }
  const lyrics = decodeXmlEntities(rawLyrics);

  const slides = slidesFromLyrics(lyrics);
  if (slides.length === 0) {
    throw new Error("OpenSong XML has a <lyrics> element but no usable lyric content");
  }

  return { title, slides };
}

module.exports = { parseOpenSong, labelForSection };
