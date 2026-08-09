#!/usr/bin/env node
// Lightweight self-test for server/lib/migration, run directly with plain node
// (no test framework). Exercises detectFormat/parseSong on each fixture format,
// and importSongsFromDir end to end against this __fixtures__ directory.
//
// Usage: node server/lib/migration/__fixtures__/selftest.js

const fs = require("fs");
const os = require("os");
const path = require("path");

// Sample song files live in a songs/ subfolder (not directly in __fixtures__/) so
// that importSongsFromDir(<fixtures dir>) below doesn't also try to "import" this
// selftest.js script itself as if it were a song file.
const SONGS_FIXTURES_DIR = path.join(__dirname, "songs");

// Route importSongsFromDir's writes to a scratch temp dir instead of the real
// data/songs, then require the module fresh so it picks up the env var.
const scratchSongsDir = fs.mkdtempSync(path.join(os.tmpdir(), "migration-selftest-"));
process.env.MIGRATION_SONGS_DIR = scratchSongsDir;
const migration = require("../index");

let pass = 0;
let fail = 0;

function check(description, condition) {
  if (condition) {
    pass += 1;
    console.log(`  ok - ${description}`);
  } else {
    fail += 1;
    console.log(`  FAIL - ${description}`);
  }
}

function readFixture(name) {
  return fs.readFileSync(path.join(FIXTURES_DIR, name), "utf8");
}

async function main() {
  console.log("== detectFormat ==");
  check(
    "OpenSong XML detected as opensong",
    migration.detectFormat(readFixture("amazing-grace.xml"), "amazing-grace.xml") === "opensong"
  );
  check(
    "ChordPro file detected as chordpro",
    migration.detectFormat(readFixture("great-is-thy-faithfulness.cho"), "great-is-thy-faithfulness.cho") ===
      "chordpro"
  );
  check(
    "Plain text file detected as plaintext",
    migration.detectFormat(readFixture("it-is-well.txt"), "it-is-well.txt") === "plaintext"
  );
  check("Empty content detected as unknown", migration.detectFormat("", "empty.xml") === "unknown");
  check(
    "Non-song XML (no <song> root) detected as unknown",
    migration.detectFormat("<?xml version=\"1.0\"?><foo><bar/></foo>", "weird.xml") === "unknown"
  );

  console.log("\n== parseSong: opensong ==");
  {
    const song = migration.parseSong(readFixture("amazing-grace.xml"), "opensong");
    check("title parsed", song.title === "Amazing Grace");
    check("id slugified", song.id === "amazing-grace");
    check("three slides parsed", song.slides.length === 3);
    check(
      'labels mapped to "Verse 1", "Verse 2", "Chorus"',
      song.slides[0].label === "Verse 1" && song.slides[1].label === "Verse 2" && song.slides[2].label === "Chorus"
    );
    check(
      "chord lines (leading '.') stripped from lyric content",
      song.slides[0].lines.every((l) => !l.startsWith(".") && !/^[A-G][#b]?\d*\s/.test(l))
    );
    check(
      "first lyric line captured correctly",
      song.slides[0].lines[0] === "Amazing grace, how sweet the sound,"
    );
  }

  console.log("\n== parseSong: chordpro ==");
  {
    const song = migration.parseSong(readFixture("great-is-thy-faithfulness.cho"), "chordpro");
    check("title parsed from {title:...} directive", song.title === "Great Is Thy Faithfulness");
    check("id slugified", song.id === "great-is-thy-faithfulness");
    check("three slides parsed (verse, chorus, verse)", song.slides.length === 3);
    check(
      "labels are Verse 1 / Chorus / Verse 2",
      song.slides[0].label === "Verse 1" && song.slides[1].label === "Chorus" && song.slides[2].label === "Verse 2"
    );
    check(
      "inline chord brackets stripped from lyric lines",
      song.slides[0].lines.every((l) => !l.includes("[") && !l.includes("]"))
    );
    check(
      "chorus line reads cleanly with chords removed",
      song.slides[1].lines[0] === "Great is Thy faithfulness, great is Thy faithfulness,"
    );
  }

  console.log("\n== parseSong: plaintext ==");
  {
    const song = migration.parseSong(readFixture("it-is-well.txt"), "plaintext");
    check("title is first non-blank line", song.title === "It Is Well With My Soul");
    check("id slugified", song.id === "it-is-well-with-my-soul");
    check("three slides parsed (verse, chorus, verse)", song.slides.length === 3);
    check(
      "labels are Verse 1 / Chorus / Verse 2",
      song.slides[0].label === "Verse 1" && song.slides[1].label === "Chorus" && song.slides[2].label === "Verse 2"
    );
    check(
      "chorus content captured under the standalone Chorus marker",
      song.slides[1].lines[0] === "It is well (it is well),"
    );
  }

  console.log("\n== parseSong: unknown format throws ==");
  try {
    migration.parseSong("whatever", "unknown");
    check("parseSong throws for unknown format", false);
  } catch (err) {
    check("parseSong throws for unknown format", err instanceof Error && err.message.length > 0);
  }

  console.log("\n== importSongsFromDir (writes to scratch dir) ==");
  {
    const result = await migration.importSongsFromDir(FIXTURES_DIR);

    check("imported the 3 well-formed fixtures", result.imported.length === 3);
    check(
      "imported ids are as expected",
      ["amazing-grace", "great-is-thy-faithfulness", "it-is-well-with-my-soul"].every((id) =>
        result.imported.includes(id)
      )
    );
    check(
      "malformed fixtures reported as errors, not thrown",
      result.errors.some((e) => e.file === "broken-no-title.xml") && result.errors.some((e) => e.file === "empty.xml")
    );
    check(
      "selftest.js itself was skipped or safely errored (not silently mistaken for a song)",
      !result.imported.includes("selftest")
    );

    for (const id of result.imported) {
      const outPath = path.join(scratchSongsDir, `${id}.json`);
      const exists = fs.existsSync(outPath);
      check(`data/songs/${id}.json written`, exists);
      if (exists) {
        const written = JSON.parse(fs.readFileSync(outPath, "utf8"));
        check(`${id}.json matches Song schema (id/title/slides)`, written.id === id && typeof written.title === "string" && Array.isArray(written.slides));
      }
    }
  }

  console.log("\n== id de-duplication ==");
  {
    // Re-run against the same fixtures dir with the same scratch songs dir already
    // populated from the previous run - re-importing the same titles should append
    // -2 suffixes rather than silently overwrite or crash.
    const result = await migration.importSongsFromDir(FIXTURES_DIR);
    check("second import of same fixtures still imports 3 songs", result.imported.length === 3);
    check(
      "collisions de-duplicated with -2 suffix",
      result.imported.includes("amazing-grace-2") &&
        result.imported.includes("great-is-thy-faithfulness-2") &&
        result.imported.includes("it-is-well-with-my-soul-2")
    );
  }

  // Clean up the scratch directory.
  fs.rmSync(scratchSongsDir, { recursive: true, force: true });

  console.log(`\n${pass} passed, ${fail} failed.`);
  if (fail > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error("Self-test crashed:", err);
  process.exitCode = 1;
});
