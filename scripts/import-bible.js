#!/usr/bin/env node
// scripts/import-bible.js
//
// Fetches public-domain Bible translations and writes them to
// data/bible/<id>.json in the schema PROTOCOL.md defines:
//
//   { "id": "kjv", "name": "...", "license": "public-domain",
//     "books": { "John": [ [verse1, verse2, ...], ... chapters ] } }
//
// Source: scrollmapper/bible_databases (github.com/scrollmapper/bible_databases),
// an open dataset of public-domain Bible translations, formats/json/<CODE>.json.
// Each source file is itself public-domain text (KJV 1769, ASV 1901, YLT 1898,
// BBE 1949/1964 are all long out of copyright) republished as structured JSON.
//
// Run with: npm run import:bible

"use strict";

const fs = require("fs");
const path = require("path");
const { CANONICAL_BOOKS, normalizeSourceBookName } = require("../server/lib/bible/books");

const BIBLE_DIR = path.join(__dirname, "..", "data", "bible");

const SOURCES = [
  {
    id: "kjv",
    name: "King James Version",
    sourceCode: "KJV",
    url: "https://raw.githubusercontent.com/scrollmapper/bible_databases/master/formats/json/KJV.json",
  },
  {
    id: "asv",
    name: "American Standard Version",
    sourceCode: "ASV",
    url: "https://raw.githubusercontent.com/scrollmapper/bible_databases/master/formats/json/ASV.json",
  },
  {
    id: "ylt",
    name: "Young's Literal Translation",
    sourceCode: "YLT",
    url: "https://raw.githubusercontent.com/scrollmapper/bible_databases/master/formats/json/YLT.json",
  },
  {
    id: "bbe",
    name: "Bible in Basic English",
    sourceCode: "BBE",
    url: "https://raw.githubusercontent.com/scrollmapper/bible_databases/master/formats/json/BBE.json",
  },
];

async function fetchJson(url) {
  const res = await fetch(url, { headers: { "User-Agent": "church-obs-presenter/1.0 (bible import script)" } });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  return res.json();
}

// Converts the scrollmapper/bible_databases shape:
//   { translation, books: [ { name, chapters: [ { chapter, verses: [ { verse, text } ] } ] } ] }
// into our schema:
//   { books: { CanonicalName: [ [verseText, ...], ... ] } }
function convert(sourceDoc) {
  const books = {};
  for (const srcBook of sourceDoc.books) {
    const canonical = normalizeSourceBookName(srcBook.name);
    if (!CANONICAL_BOOKS.includes(canonical)) {
      console.warn(`  ! unrecognized book "${srcBook.name}" (normalized to "${canonical}") - skipping`);
      continue;
    }
    const chapters = [];
    const sortedChapters = [...srcBook.chapters].sort((a, b) => a.chapter - b.chapter);
    for (const ch of sortedChapters) {
      const verses = [...ch.verses].sort((a, b) => a.verse - b.verse).map((v) => String(v.text).trim());
      chapters[ch.chapter - 1] = verses;
    }
    books[canonical] = chapters;
  }
  return books;
}

async function importOne(src) {
  console.log(`Fetching ${src.name} (${src.id}) from ${src.url} ...`);
  let sourceDoc;
  try {
    sourceDoc = await fetchJson(src.url);
  } catch (err) {
    console.error(`  ! failed to fetch ${src.id}: ${err.message}`);
    return { id: src.id, ok: false, reason: err.message };
  }

  const books = convert(sourceDoc);
  const bookCount = Object.keys(books).length;
  const verseCount = Object.values(books).reduce(
    (sum, chapters) => sum + chapters.reduce((s, verses) => s + (verses ? verses.length : 0), 0),
    0
  );

  const out = {
    id: src.id,
    name: src.name,
    license: "public-domain",
    books,
  };

  if (!fs.existsSync(BIBLE_DIR)) fs.mkdirSync(BIBLE_DIR, { recursive: true });
  const outPath = path.join(BIBLE_DIR, `${src.id}.json`);
  fs.writeFileSync(outPath, JSON.stringify(out));
  console.log(`  wrote ${outPath} (${bookCount}/${CANONICAL_BOOKS.length} books, ${verseCount} verses)`);
  return { id: src.id, ok: true, bookCount, verseCount };
}

async function main() {
  console.log(`Importing public-domain Bible translations into ${BIBLE_DIR}\n`);
  const results = [];
  for (const src of SOURCES) {
    // Sequential on purpose: polite to the raw.githubusercontent.com host and
    // makes failures easy to attribute to a specific source in the log.
    results.push(await importOne(src));
  }

  console.log("\nSummary:");
  for (const r of results) {
    if (r.ok) {
      console.log(`  ${r.id}: OK - ${r.bookCount}/${CANONICAL_BOOKS.length} books, ${r.verseCount} verses`);
    } else {
      console.log(`  ${r.id}: FAILED - ${r.reason}`);
    }
  }

  const failures = results.filter((r) => !r.ok);
  if (failures.length > 0) {
    console.log(
      "\nSome translations failed to import (likely network restrictions in this environment)." +
        "\nIf ALL of them failed, data/bible/ still has the hand-transcribed fallback files" +
        " (see data/bible/README.md if present, or the project report) covering a couple of" +
        " complete short books/chapters so search + lookup remain testable end-to-end." +
        "\nRe-run `npm run import:bible` on a machine with unrestricted internet access to" +
        " get the full Bible text for every translation."
    );
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error("Import failed:", err);
  process.exitCode = 1;
});
