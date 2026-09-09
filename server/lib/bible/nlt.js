// server/lib/bible/nlt.js
//
// Client for Tyndale's official NLT API (api.nlt.to), used only for the
// "nlt" translation. A free key can be registered at https://api.nlt.to/ and
// stored in data/config/secrets.json as { "nltApiKey": "..." } for higher
// rate limits, but Tyndale's own terms explicitly permit anonymous access
// for non-commercial use (capped at 50 verses/request, 500 requests/day) -
// so this works with no key at all, just at a lower ceiling. Never bundle
// NLT text into this repo's data files - it is copyrighted and must be
// fetched live per the NLT API terms.
//
// Endpoint reference (confirmed live 2026-09-09):
//   GET https://api.nlt.to/api/passages?ref=<Book.Chapter.Verse>&version=NLT&key=<nltApiKey>
//   Response: an HTML page (not JSON) - the verse text lives inside a single
//   <verse_export> element, wrapped in markup like:
//     <verse_export ...><p class="body"><span class="vn">16</span>
//       <span class="red">actual verse text<a class="a-tn">*</a>
//       <span class="tn">footnote text</span></span></p></verse_export>
//   "vn" = verse number (strip whole element - number included), "tn"/"a-tn"
//   = translator's footnote + its marker (strip whole element), "red" =
//   words of Christ (keep the text, just unwrap the tag).
//
// The API's `ref` book token is almost always just the full canonical book
// name (e.g. "1 Corinthians", "Revelation") - verified against Genesis,
// John, 1 Corinthians, Psalms, Revelation, Philemon, 1 Peter,
// 2 Thessalonians, and Ecclesiastes. "Song of Solomon" is the one confirmed
// exception (needs "Song").

"use strict";

const NLT_API_BASE = "https://api.nlt.to/api/passages";

class NltApiError extends Error {}

const BOOK_REF_OVERRIDES = {
  "Song of Solomon": "Song",
};

function nltBookRef(book) {
  return BOOK_REF_OVERRIDES[book] || book;
}

// Removes a <tagName class="cls">...</tagName> element - including any
// nested tags of the same name inside it - by tracking open/close depth,
// since a naive non-greedy regex would stop at the first inner </span>
// instead of the matching outer one (the "tn" footnote span nests a
// "tn-ref" span exactly like this).
function stripNestedElement(html, tagName, cls) {
  const openRe = new RegExp(`<${tagName}\\b[^>]*class="${cls}"[^>]*>`, "i");
  let result = html;
  for (;;) {
    const openMatch = result.match(openRe);
    if (!openMatch) break;
    const start = openMatch.index;
    const tagRe = new RegExp(`<${tagName}\\b[^>]*>|<\\/${tagName}>`, "gi");
    tagRe.lastIndex = start + openMatch[0].length;
    let depth = 1;
    let end = result.length;
    let m;
    while ((m = tagRe.exec(result))) {
      if (m[0][1] === "/") depth--;
      else depth++;
      if (depth === 0) {
        end = m.index + m[0].length;
        break;
      }
    }
    result = result.slice(0, start) + result.slice(end);
  }
  return result;
}

function decodeEntities(str) {
  return str
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function cleanVerseHtml(inner) {
  // Verse 1 of a chapter comes bundled with chapter/section furniture -
  // heading tags (chapter number, section subheads) and Psalm-style
  // superscriptions ("A psalm of David.", class="psa-title") - none of
  // which is actual verse text, so strip them before anything else.
  let out = inner.replace(/<h[1-6]\b[^>]*>[\s\S]*?<\/h[1-6]>/gi, "");
  out = out.replace(/<p\b[^>]*class="[^"]*title[^"]*"[^>]*>[\s\S]*?<\/p>/gi, "");
  out = stripNestedElement(out, "span", "tn"); // footnote text
  out = out.replace(/<a\b[^>]*class="a-tn"[^>]*>[\s\S]*?<\/a>/gi, ""); // footnote marker
  out = stripNestedElement(out, "span", "vn"); // verse number
  out = out.replace(/<[^>]+>/g, ""); // everything else is just a wrapper tag
  out = decodeEntities(out);
  return out.replace(/\s+/g, " ").trim();
}

// A "ref" can name a single verse, a range, or a whole chapter (see
// fetchPassage below) - in every case the response has one <verse_export
// ... vn="N"> block per verse, so this always returns a list, even for a
// single verse.
function parseVerseExports(html) {
  const results = [];
  const re = /<verse_export\b([^>]*)>([\s\S]*?)<\/verse_export>/gi;
  let m;
  while ((m = re.exec(html))) {
    const vnMatch = m[1].match(/\bvn="(\d+)"/);
    if (!vnMatch) continue;
    const text = cleanVerseHtml(m[2]);
    if (text) results.push({ verse: Number(vnMatch[1]), text });
  }
  return results;
}

// verseStart/verseEnd both null -> whole chapter; verseEnd null -> single
// verse; otherwise a range - all resolved in ONE request (confirmed live:
// "John.3", "John.3.16", and "John.3.16-18" all work), rather than one
// request per verse, since anonymous/free-tier access is rate-limited by
// request count per day.
async function fetchPassage(book, chapter, verseStart, verseEnd, apiKey) {
  const bookRef = nltBookRef(book);
  let ref = `${bookRef}.${chapter}`;
  if (verseStart != null) {
    ref += `.${verseStart}`;
    if (verseEnd != null && verseEnd !== verseStart) ref += `-${verseEnd}`;
  }
  const params = new URLSearchParams({ ref, version: "NLT" });
  if (apiKey) params.set("key", apiKey);

  let res;
  try {
    res = await fetch(`${NLT_API_BASE}?${params.toString()}`);
  } catch (err) {
    throw new NltApiError(`NLT API request failed: ${err.message}`);
  }
  if (!res.ok) {
    throw new NltApiError(`NLT API returned HTTP ${res.status}`);
  }

  const html = await res.text();
  const verses = parseVerseExports(html);
  if (verses.length === 0) {
    throw new NltApiError(`NLT API returned no text for "${ref}"`);
  }

  return verses.map((v) => ({ book, chapter: Number(chapter), verse: v.verse, text: v.text }));
}

async function fetchVerse(book, chapter, verse, apiKey) {
  const [result] = await fetchPassage(book, chapter, verse, verse, apiKey);
  return result;
}

module.exports = { fetchVerse, fetchPassage, NltApiError };
