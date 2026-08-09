// server/lib/bible/index.js
//
// Bible data layer: offline public-domain translations (loaded once into
// memory from data/bible/*.json) plus transparent fetch+cache for licensed
// translations (ESV via esv.js, NIV/AMP via apibible.js). Implements exactly
// the module contract in PROTOCOL.md's "Module contract: server/lib/bible".

"use strict";

const fs = require("fs");
const path = require("path");
const { resolveBookAlias } = require("./books");
const esv = require("./esv");
const apibible = require("./apibible");

const DATA_DIR = path.join(__dirname, "..", "..", "..", "data");
const BIBLE_DIR = path.join(DATA_DIR, "bible");
const SECRETS_FILE = path.join(DATA_DIR, "config", "secrets.json");

// Licensed translations that don't have offline data. Listed unconditionally
// (per PROTOCOL.md requirement) so /control can show them as options; getVerse
// is what actually gates on an API key being configured, not this list.
// TPT (The Passion Translation) intentionally has no entry here - there is no
// known free public API for it, so it's simply absent rather than half-wired.
const LICENSED_TRANSLATIONS = [
  { id: "esv", name: "English Standard Version", source: "esv", licensed: true },
  { id: "niv", name: "New International Version", source: "apibible", licensed: true },
  { id: "amp", name: "Amplified Bible", source: "apibible", licensed: true },
];
const LICENSED_IDS = new Set(LICENSED_TRANSLATIONS.map((t) => t.id));

const MAX_ESV_CACHE_ENTRIES = 500; // ESV API terms: never hold more than 500 verses.

// ---- module state, populated by init() ----

let offline = new Map(); // translationId -> { id, name, license, source, licensed, books, verseIndex }
let secrets = {}; // { esvApiKey, apiBibleKey } if data/config/secrets.json exists
let licensedCache = new Map(); // translationId -> Map(cacheKey -> verse result)

function cacheKey(book, chapter, verse) {
  return `${book}|${chapter}|${verse}`;
}

function getOrCreateCache(translationId) {
  if (!licensedCache.has(translationId)) licensedCache.set(translationId, new Map());
  return licensedCache.get(translationId);
}

function cacheSet(translationId, key, value) {
  const cache = getOrCreateCache(translationId);
  cache.set(key, value);
  if (translationId === "esv" && cache.size > MAX_ESV_CACHE_ENTRIES) {
    // Map preserves insertion order - evict the oldest entry.
    const oldestKey = cache.keys().next().value;
    cache.delete(oldestKey);
  }
}

// Builds a flat, pre-lowercased verse index for fast keyword search.
function buildVerseIndex(books) {
  const index = [];
  for (const [book, chapters] of Object.entries(books)) {
    for (let chapterIdx = 0; chapterIdx < chapters.length; chapterIdx++) {
      const verses = chapters[chapterIdx];
      if (!verses) continue;
      for (let verseIdx = 0; verseIdx < verses.length; verseIdx++) {
        const text = verses[verseIdx];
        if (text === undefined || text === null) continue;
        index.push({
          book,
          chapter: chapterIdx + 1,
          verse: verseIdx + 1,
          text,
          lower: text.toLowerCase(),
        });
      }
    }
  }
  return index;
}

// ---- init ----

async function init() {
  offline = new Map();
  licensedCache = new Map();

  if (fs.existsSync(BIBLE_DIR)) {
    const files = fs.readdirSync(BIBLE_DIR).filter((f) => f.endsWith(".json"));
    for (const file of files) {
      const filePath = path.join(BIBLE_DIR, file);
      try {
        const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
        const id = raw.id || path.basename(file, ".json");
        offline.set(id, {
          id,
          name: raw.name || id.toUpperCase(),
          license: raw.license || "public-domain",
          source: "offline",
          licensed: false,
          books: raw.books || {},
          verseIndex: buildVerseIndex(raw.books || {}),
        });
      } catch (err) {
        console.error(`bible: failed to load ${filePath}: ${err.message}`);
      }
    }
  }

  secrets = {};
  if (fs.existsSync(SECRETS_FILE)) {
    try {
      secrets = JSON.parse(fs.readFileSync(SECRETS_FILE, "utf8")) || {};
    } catch (err) {
      console.error(`bible: failed to parse ${SECRETS_FILE}: ${err.message}`);
    }
  }
}

// ---- listTranslations ----

function listTranslations() {
  const offlineList = [...offline.values()].map((t) => ({
    id: t.id,
    name: t.name,
    source: t.source,
    licensed: t.licensed,
  }));
  return [...offlineList, ...LICENSED_TRANSLATIONS];
}

// ---- reference parsing ----

// Matches "<book> <chapter>[:<verse>[-<verseEnd>]]" where <book> may be
// multiple words/tokens (e.g. "song of solomon", "1 cor", "1cor").
const REFERENCE_RE =
  /^([1-3a-z]+(?:\s+[a-z]+)*?)\s+(\d{1,3})(?::(\d{1,3})(?:-(\d{1,3}))?)?$/i;

// Parses a query string into a structured reference, or null if it doesn't
// look like one (caller should fall back to keyword search).
function parseReference(query) {
  const trimmed = String(query || "").trim().toLowerCase();
  if (!trimmed) return null;
  const match = trimmed.match(REFERENCE_RE);
  if (!match) return null;

  const [, bookToken, chapterStr, verseStr, verseEndStr] = match;
  const book = resolveBookAlias(bookToken);
  if (!book) return null;

  const chapter = Number(chapterStr);
  const verse = verseStr ? Number(verseStr) : null;
  const verseEnd = verseEndStr ? Number(verseEndStr) : null;
  if (!Number.isFinite(chapter) || chapter < 1) return null;

  return { book, chapter, verse, verseEnd };
}

// ---- searchOffline ----

function searchOffline(query, translationIds) {
  const trimmed = String(query || "").trim();
  if (!trimmed || !Array.isArray(translationIds) || translationIds.length === 0) return [];

  const translations = translationIds
    .map((id) => offline.get(id))
    .filter(Boolean);
  if (translations.length === 0) return [];

  const reference = parseReference(trimmed);
  if (reference) {
    return searchByReference(reference, translations);
  }
  return searchByKeyword(trimmed, translations);
}

function searchByReference(reference, translations) {
  const { book, chapter, verse, verseEnd } = reference;
  const results = [];
  for (const t of translations) {
    const chapters = t.books[book];
    if (!chapters) continue;
    const verses = chapters[chapter - 1];
    if (!verses) continue;

    if (verse === null) {
      // Whole chapter.
      verses.forEach((text, idx) => {
        results.push({ translation: t.id, book, chapter, verse: idx + 1, text });
      });
    } else {
      const end = verseEnd || verse;
      for (let v = verse; v <= end; v++) {
        const text = verses[v - 1];
        if (text === undefined) continue;
        results.push({ translation: t.id, book, chapter, verse: v, text });
      }
    }
  }
  return results;
}

function searchByKeyword(query, translations) {
  const phrase = query.toLowerCase();
  const tokens = phrase.split(/\s+/).filter(Boolean);
  const MAX_RESULTS = 25;

  const scored = [];
  for (const t of translations) {
    for (const entry of t.verseIndex) {
      let rank;
      if (entry.lower.includes(phrase)) {
        rank = 0; // exact phrase match
      } else if (tokens.every((tok) => entry.lower.includes(tok))) {
        rank = 1; // all keywords present
      } else if (tokens.some((tok) => entry.lower.includes(tok))) {
        rank = 2; // some keywords present
      } else {
        continue;
      }
      scored.push({
        rank,
        result: {
          translation: t.id,
          book: entry.book,
          chapter: entry.chapter,
          verse: entry.verse,
          text: entry.text,
        },
      });
    }
  }

  scored.sort((a, b) => a.rank - b.rank);
  return scored.slice(0, MAX_RESULTS).map((s) => s.result);
}

// ---- getVerse ----

async function getVerse(translationId, book, chapter, verse) {
  const canonicalBook = resolveBookAlias(book) || book;
  const chapterNum = Number(chapter);
  const verseNum = Number(verse);

  const offlineTranslation = offline.get(translationId);
  if (offlineTranslation) {
    const chapters = offlineTranslation.books[canonicalBook];
    const text = chapters && chapters[chapterNum - 1] && chapters[chapterNum - 1][verseNum - 1];
    if (text === undefined) return null;
    return {
      translation: translationId,
      book: canonicalBook,
      chapter: chapterNum,
      verse: verseNum,
      text,
      source: "offline",
    };
  }

  if (LICENSED_IDS.has(translationId)) {
    const key = cacheKey(canonicalBook, chapterNum, verseNum);
    const cache = getOrCreateCache(translationId);
    if (cache.has(key)) {
      const cached = cache.get(key);
      return { translation: translationId, ...cached, source: "cache" };
    }

    let fetched;
    if (translationId === "esv") {
      fetched = await esv.fetchVerse(canonicalBook, chapterNum, verseNum, secrets.esvApiKey);
    } else {
      // niv, amp, and any future apibible-backed translation.
      fetched = await apibible.fetchVerse(canonicalBook, chapterNum, verseNum, secrets.apiBibleKey, translationId);
    }

    cacheSet(translationId, key, fetched);
    return { translation: translationId, ...fetched, source: "live" };
  }

  // Unknown translation id (e.g. "tpt", which has no implementation) -
  // degrade gracefully rather than throwing.
  return null;
}

module.exports = { init, listTranslations, searchOffline, getVerse };
