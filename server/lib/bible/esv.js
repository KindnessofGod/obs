// server/lib/bible/esv.js
//
// Client for the official ESV API (api.esv.org), used only for the "esv"
// translation. Requires a free/registered API key from https://api.esv.org/
// stored in data/config/secrets.json as { "esvApiKey": "..." }. Never bundle
// ESV text into this repo's data files - it is copyrighted and must be
// fetched live per the ESV API terms.
//
// Endpoint reference (api.esv.org v3 "Text" passage endpoint):
//   GET https://api.esv.org/v3/passage/text/?q=<passage>
//   Header: Authorization: Token <esvApiKey>
//   Response: { query, canonical, parsed, passage_meta: [...], passages: ["..."] }
//
// We request a single verse and strip headings/footnotes/verse-numbers so
// `passages[0]` is just the plain verse text.

"use strict";

const ESV_API_BASE = "https://api.esv.org/v3/passage/text/";

// Thrown when the key is missing/unconfigured, or the upstream API errors.
// index.js is expected to catch this and surface a clear (non-crashing)
// error to the caller, per PROTOCOL.md.
class EsvApiError extends Error {}

async function fetchVerse(book, chapter, verse, apiKey) {
  if (!apiKey) {
    throw new EsvApiError(
      "ESV API key not configured (set esvApiKey in data/config/secrets.json)"
    );
  }

  const passage = `${book} ${chapter}:${verse}`;
  const params = new URLSearchParams({
    q: passage,
    "include-headings": "false",
    "include-footnotes": "false",
    "include-verse-numbers": "false",
    "include-short-copyright": "false",
    "include-passage-references": "false",
    "include-first-verse-numbers": "false",
  });

  let res;
  try {
    res = await fetch(`${ESV_API_BASE}?${params.toString()}`, {
      headers: { Authorization: `Token ${apiKey}` },
    });
  } catch (err) {
    throw new EsvApiError(`ESV API request failed: ${err.message}`);
  }

  if (!res.ok) {
    throw new EsvApiError(`ESV API returned HTTP ${res.status}`);
  }

  const data = await res.json();
  const text = Array.isArray(data.passages) && data.passages[0] ? data.passages[0].trim() : "";
  if (!text) {
    throw new EsvApiError(`ESV API returned no text for "${passage}"`);
  }

  return { book, chapter: Number(chapter), verse: Number(verse), text };
}

module.exports = { fetchVerse, EsvApiError };
