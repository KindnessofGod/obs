// server/lib/bible/apibible.js
//
// Client for api.scripture.api.bible ("API.Bible"), used for licensed
// translations that aren't ESV - currently NIV and AMP. Requires a free
// developer API key from https://scripture.api.bible/ stored in
// data/config/secrets.json as { "apiBibleKey": "..." }.
//
// API.Bible accounts are granted access to specific Bible editions
// (identified by an opaque `bibleId`); which editions a given key can see is
// account-specific, so instead of hardcoding a bibleId (which could easily
// be wrong/stale for a given key) we resolve it once per process by listing
// the key's available bibles and matching on abbreviation, then cache it.
//
// Endpoint reference:
//   GET https://api.scripture.api.bible/v1/bibles              (list bibles available to this key)
//   GET https://api.scripture.api.bible/v1/bibles/{bibleId}/passages/{passageId}
//       passageId is a USFM reference, e.g. "JHN.3.16"
//   Header on every request: api-key: <apiBibleKey>

"use strict";

const { USFM_CODES } = require("./books");

const API_BASE = "https://api.scripture.api.bible/v1";

// translationId -> likely abbreviation(s) to match against the account's
// bible list. First match wins.
const ABBREVIATION_HINTS = {
  niv: ["NIV"],
  amp: ["AMP"],
};

class ApiBibleError extends Error {}

// bibleId resolution cache, keyed by translationId, for the life of the process.
const bibleIdCache = new Map();

async function listBibles(apiKey) {
  let res;
  try {
    res = await fetch(`${API_BASE}/bibles`, { headers: { "api-key": apiKey } });
  } catch (err) {
    throw new ApiBibleError(`API.Bible request failed: ${err.message}`);
  }
  if (!res.ok) {
    throw new ApiBibleError(`API.Bible returned HTTP ${res.status} listing bibles`);
  }
  const data = await res.json();
  return Array.isArray(data.data) ? data.data : [];
}

async function resolveBibleId(translationId, apiKey) {
  if (bibleIdCache.has(translationId)) return bibleIdCache.get(translationId);

  const hints = ABBREVIATION_HINTS[translationId] || [translationId.toUpperCase()];
  const bibles = await listBibles(apiKey);
  const match = bibles.find((b) =>
    hints.some(
      (hint) =>
        (b.abbreviation && b.abbreviation.toUpperCase() === hint) ||
        (b.abbreviationLocal && b.abbreviationLocal.toUpperCase() === hint)
    )
  );

  if (!match) {
    throw new ApiBibleError(
      `No API.Bible edition matching "${translationId}" is available to this API key ` +
        `(checked abbreviations: ${hints.join(", ")}). This account may not have that ` +
        `translation licensed.`
    );
  }

  bibleIdCache.set(translationId, match.id);
  return match.id;
}

// fetchVerse(book, chapter, verse) matches the module contract exactly.
// The optional trailing args let index.js (the only caller) tell us the
// configured API key and *which* licensed translation (niv, amp, ...) to
// resolve against this shared API.Bible client; both default sensibly so the
// function still behaves correctly if called with just the documented 3
// arguments (it will simply report the key as missing).
async function fetchVerse(book, chapter, verse, apiKey = null, translationId = "niv") {
  if (!apiKey) {
    throw new ApiBibleError(
      "API.Bible key not configured (set apiBibleKey in data/config/secrets.json)"
    );
  }

  const usfm = USFM_CODES[book];
  if (!usfm) {
    throw new ApiBibleError(`Unknown book "${book}" - no USFM code mapping`);
  }

  const bibleId = await resolveBibleId(translationId, apiKey);
  const passageId = `${usfm}.${chapter}.${verse}`;
  const params = new URLSearchParams({
    "content-type": "text",
    "include-notes": "false",
    "include-titles": "false",
    "include-chapter-numbers": "false",
    "include-verse-numbers": "false",
    "include-verse-spans": "false",
  });

  let res;
  try {
    res = await fetch(`${API_BASE}/bibles/${bibleId}/passages/${passageId}?${params.toString()}`, {
      headers: { "api-key": apiKey },
    });
  } catch (err) {
    throw new ApiBibleError(`API.Bible request failed: ${err.message}`);
  }
  if (!res.ok) {
    throw new ApiBibleError(`API.Bible returned HTTP ${res.status} for ${passageId}`);
  }

  const data = await res.json();
  const text = data && data.data && typeof data.data.content === "string" ? data.data.content.trim() : "";
  if (!text) {
    throw new ApiBibleError(`API.Bible returned no text for ${passageId}`);
  }

  return { book, chapter: Number(chapter), verse: Number(verse), text };
}

module.exports = { fetchVerse, ApiBibleError };
