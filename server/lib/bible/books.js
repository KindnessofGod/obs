// server/lib/bible/books.js
//
// Canonical book list, alias/abbreviation table, and USFM 3-letter codes.
// Shared by scripts/import-bible.js (to normalize source book names into the
// canonical form the PROTOCOL.md schema expects) and server/lib/bible/index.js
// (to parse reference queries like "jn 3:16" or "1 cor 13").

"use strict";

// Canonical 66-book Protestant canon, in reading order. This is the exact
// key set expected under `books.<BookName>` in data/bible/<id>.json per
// PROTOCOL.md.
const CANONICAL_BOOKS = [
  "Genesis", "Exodus", "Leviticus", "Numbers", "Deuteronomy",
  "Joshua", "Judges", "Ruth", "1 Samuel", "2 Samuel",
  "1 Kings", "2 Kings", "1 Chronicles", "2 Chronicles", "Ezra",
  "Nehemiah", "Esther", "Job", "Psalms", "Proverbs",
  "Ecclesiastes", "Song of Solomon", "Isaiah", "Jeremiah", "Lamentations",
  "Ezekiel", "Daniel", "Hosea", "Joel", "Amos",
  "Obadiah", "Jonah", "Micah", "Nahum", "Habakkuk",
  "Zephaniah", "Haggai", "Zechariah", "Malachi",
  "Matthew", "Mark", "Luke", "John", "Acts",
  "Romans", "1 Corinthians", "2 Corinthians", "Galatians", "Ephesians",
  "Philippians", "Colossians", "1 Thessalonians", "2 Thessalonians",
  "1 Timothy", "2 Timothy", "Titus", "Philemon", "Hebrews",
  "James", "1 Peter", "2 Peter", "1 John", "2 John",
  "3 John", "Jude", "Revelation",
];

// Standard USFM 3-letter codes, used by api.scripture.api.bible passage IDs
// (e.g. "JHN.3.16"). Well-known/standard identifiers, not copyrighted text.
const USFM_CODES = {
  Genesis: "GEN", Exodus: "EXO", Leviticus: "LEV", Numbers: "NUM", Deuteronomy: "DEU",
  Joshua: "JOS", Judges: "JDG", Ruth: "RUT", "1 Samuel": "1SA", "2 Samuel": "2SA",
  "1 Kings": "1KI", "2 Kings": "2KI", "1 Chronicles": "1CH", "2 Chronicles": "2CH", Ezra: "EZR",
  Nehemiah: "NEH", Esther: "EST", Job: "JOB", Psalms: "PSA", Proverbs: "PRO",
  Ecclesiastes: "ECC", "Song of Solomon": "SNG", Isaiah: "ISA", Jeremiah: "JER", Lamentations: "LAM",
  Ezekiel: "EZK", Daniel: "DAN", Hosea: "HOS", Joel: "JOL", Amos: "AMO",
  Obadiah: "OBA", Jonah: "JON", Micah: "MIC", Nahum: "NAM", Habakkuk: "HAB",
  Zephaniah: "ZEP", Haggai: "HAG", Zechariah: "ZEC", Malachi: "MAL",
  Matthew: "MAT", Mark: "MRK", Luke: "LUK", John: "JHN", Acts: "ACT",
  Romans: "ROM", "1 Corinthians": "1CO", "2 Corinthians": "2CO", Galatians: "GAL", Ephesians: "EPH",
  Philippians: "PHP", Colossians: "COL", "1 Thessalonians": "1TH", "2 Thessalonians": "2TH",
  "1 Timothy": "1TI", "2 Timothy": "2TI", Titus: "TIT", Philemon: "PHM", Hebrews: "HEB",
  James: "JAS", "1 Peter": "1PE", "2 Peter": "2PE", "1 John": "1JN", "2 John": "2JN",
  "3 John": "3JN", Jude: "JUD", Revelation: "REV",
};

// alias (lowercase, no punctuation) -> canonical book name.
// Covers full names, common church/software abbreviations, and numbered-book
// variants (1/2/3, I/II/III, first/second/third).
const RAW_ALIASES = {
  Genesis: ["genesis", "gen", "ge", "gn"],
  Exodus: ["exodus", "exod", "exo", "ex"],
  Leviticus: ["leviticus", "lev", "le", "lv"],
  Numbers: ["numbers", "num", "nu", "nm", "nb"],
  Deuteronomy: ["deuteronomy", "deut", "deu", "dt"],
  Joshua: ["joshua", "josh", "jos", "jsh"],
  Judges: ["judges", "judg", "jdg", "jg"],
  Ruth: ["ruth", "rut", "ru"],
  "1 Samuel": ["1 samuel", "1samuel", "1 sam", "1sam", "1 sa", "1sa", "i samuel", "first samuel"],
  "2 Samuel": ["2 samuel", "2samuel", "2 sam", "2sam", "2 sa", "2sa", "ii samuel", "second samuel"],
  "1 Kings": ["1 kings", "1kings", "1 kgs", "1kgs", "1 ki", "1ki", "i kings", "first kings"],
  "2 Kings": ["2 kings", "2kings", "2 kgs", "2kgs", "2 ki", "2ki", "ii kings", "second kings"],
  "1 Chronicles": ["1 chronicles", "1chronicles", "1 chron", "1chron", "1 chr", "1chr", "i chronicles", "first chronicles"],
  "2 Chronicles": ["2 chronicles", "2chronicles", "2 chron", "2chron", "2 chr", "2chr", "ii chronicles", "second chronicles"],
  Ezra: ["ezra", "ezr", "ez"],
  Nehemiah: ["nehemiah", "neh", "ne"],
  Esther: ["esther", "esth", "est", "es"],
  Job: ["job", "jb"],
  Psalms: ["psalms", "psalm", "psa", "ps", "pss"],
  Proverbs: ["proverbs", "prov", "pro", "prv", "pr"],
  Ecclesiastes: ["ecclesiastes", "eccles", "eccl", "ecc", "ec"],
  "Song of Solomon": ["song of solomon", "song of songs", "songofsolomon", "song", "sos", "sng", "canticles"],
  Isaiah: ["isaiah", "isa", "is"],
  Jeremiah: ["jeremiah", "jer", "je"],
  Lamentations: ["lamentations", "lam", "la"],
  Ezekiel: ["ezekiel", "ezek", "eze", "ezk"],
  Daniel: ["daniel", "dan", "da", "dn"],
  Hosea: ["hosea", "hos", "ho"],
  Joel: ["joel", "joe", "jl"],
  Amos: ["amos", "amo", "am"],
  Obadiah: ["obadiah", "obad", "oba", "ob"],
  Jonah: ["jonah", "jon", "jnh"],
  Micah: ["micah", "mic", "mc"],
  Nahum: ["nahum", "nah", "na"],
  Habakkuk: ["habakkuk", "hab", "hb"],
  Zephaniah: ["zephaniah", "zeph", "zep", "zp"],
  Haggai: ["haggai", "hag", "hg"],
  Zechariah: ["zechariah", "zech", "zec", "zc"],
  Malachi: ["malachi", "mal", "ml"],
  Matthew: ["matthew", "matt", "mat", "mt"],
  Mark: ["mark", "mrk", "mk", "mr"],
  Luke: ["luke", "luk", "lk"],
  John: ["john", "joh", "jhn", "jn"],
  Acts: ["acts", "act", "ac"],
  Romans: ["romans", "rom", "ro", "rm"],
  "1 Corinthians": ["1 corinthians", "1corinthians", "1 cor", "1cor", "1 co", "1co", "i corinthians", "first corinthians"],
  "2 Corinthians": ["2 corinthians", "2corinthians", "2 cor", "2cor", "2 co", "2co", "ii corinthians", "second corinthians"],
  Galatians: ["galatians", "gal", "ga"],
  Ephesians: ["ephesians", "eph", "ephes"],
  Philippians: ["philippians", "phil", "php", "pp"],
  Colossians: ["colossians", "col", "co"],
  "1 Thessalonians": ["1 thessalonians", "1thessalonians", "1 thess", "1thess", "1 th", "1th", "i thessalonians", "first thessalonians"],
  "2 Thessalonians": ["2 thessalonians", "2thessalonians", "2 thess", "2thess", "2 th", "2th", "ii thessalonians", "second thessalonians"],
  "1 Timothy": ["1 timothy", "1timothy", "1 tim", "1tim", "1 ti", "1ti", "i timothy", "first timothy"],
  "2 Timothy": ["2 timothy", "2timothy", "2 tim", "2tim", "2 ti", "2ti", "ii timothy", "second timothy"],
  Titus: ["titus", "tit", "ti"],
  Philemon: ["philemon", "philem", "phm", "phlm"],
  Hebrews: ["hebrews", "heb"],
  James: ["james", "jas", "jm"],
  "1 Peter": ["1 peter", "1peter", "1 pet", "1pet", "1 pe", "1pe", "i peter", "first peter"],
  "2 Peter": ["2 peter", "2peter", "2 pet", "2pet", "2 pe", "2pe", "ii peter", "second peter"],
  "1 John": ["1 john", "1john", "1 jn", "1jn", "1 jo", "1jo", "i john", "first john"],
  "2 John": ["2 john", "2john", "2 jn", "2jn", "2 jo", "2jo", "ii john", "second john"],
  "3 John": ["3 john", "3john", "3 jn", "3jn", "3 jo", "3jo", "iii john", "third john"],
  Jude: ["jude", "jud", "jd"],
  Revelation: ["revelation", "revelations", "rev", "re"],
};

// Flatten into a single lookup map: alias -> canonical name.
const ALIASES = new Map();
for (const [canonical, aliases] of Object.entries(RAW_ALIASES)) {
  ALIASES.set(canonical.toLowerCase(), canonical);
  for (const alias of aliases) ALIASES.set(alias, canonical);
}

// Normalizes a raw book-name token (e.g. "1cor", "Jn", "song of solomon")
// into the canonical book name, or null if unrecognized.
function resolveBookAlias(token) {
  if (!token) return null;
  const key = String(token).trim().toLowerCase().replace(/\.+/g, "").replace(/\s+/g, " ");
  if (ALIASES.has(key)) return ALIASES.get(key);
  // Try again collapsing "1 cor" <-> "1cor" style spacing differences.
  const noSpace = key.replace(/\s+/g, "");
  if (ALIASES.has(noSpace)) return ALIASES.get(noSpace);
  return null;
}

// Normalizes book names as they appear in the scrollmapper/bible_databases
// source export (e.g. "I Samuel", "II Kings", "Revelation of John") into our
// canonical schema names. Falls back to returning the input unchanged if it
// already matches (or if nothing matches, so import surfaces the mismatch
// instead of silently dropping data).
function normalizeSourceBookName(sourceName) {
  let name = String(sourceName).trim();
  name = name.replace(/^III\s+/, "3 ").replace(/^II\s+/, "2 ").replace(/^I\s+/, "1 ");
  name = name.replace(/\s+of John$/i, ""); // "Revelation of John" -> "Revelation"
  if (CANONICAL_BOOKS.includes(name)) return name;
  // Last resort: alias table.
  const resolved = resolveBookAlias(name);
  return resolved || name;
}

module.exports = {
  CANONICAL_BOOKS,
  USFM_CODES,
  resolveBookAlias,
  normalizeSourceBookName,
};
