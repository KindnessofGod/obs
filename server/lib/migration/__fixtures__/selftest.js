#!/usr/bin/env node
// Lightweight self-test for server/lib/migration, run directly with plain node
// (no test framework). Exercises detectFormat/parseSong on each fixture format,
// and importSongsFromDir end to end against the __fixtures__/songs directory.
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
  return fs.readFileSync(path.join(SONGS_FIXTURES_DIR, name), "utf8");
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
  check(
    "VideoPsalm songbook JSON detected as videopsalm",
    migration.detectFormat(readFixture("videopsalm-songbook.json"), "videopsalm-songbook.json") === "videopsalm"
  );
  check(
    "VideoPsalm batch-wrapped songbook JSON detected as videopsalm",
    migration.detectFormat(readFixture("videopsalm-batch.json"), "videopsalm-batch.json") === "videopsalm"
  );
  check(
    "VideoPsalm .vpc (compressed) detected as videopsalm-compressed regardless of content",
    migration.detectFormat("whatever bytes", "songbook.vpc") === "videopsalm-compressed"
  );
  check("Empty content detected as unknown", migration.detectFormat("", "empty.xml") === "unknown");
  check(
    "Non-song XML (no <song> root) detected as unknown",
    migration.detectFormat("<?xml version=\"1.0\"?><foo><bar/></foo>", "weird.xml") === "unknown"
  );
  check(
    "Arbitrary non-XML, non-directive text falls back to plaintext",
    migration.detectFormat("Just Some Random Text\n\nWith a couple of lines.\nAnd more.", "notes.dat") === "plaintext"
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

  console.log("\n== parseSongs: videopsalm (single songbook object, multiple songs per file) ==");
  {
    const songs = migration.parseSongs(readFixture("videopsalm-songbook.json"), "videopsalm");
    check("two songs extracted from one songbook file", songs.length === 2);
    check("first song title parsed", songs[0].title === "How Great Thou Art");
    check("first song id slugified", songs[0].id === "how-great-thou-art");
    check("first song has 3 slides from Sequence-ordered Verses", songs[0].slides.length === 3);
    check(
      "labels derived from Sequence tokens (Verse 1 / Chorus / Verse 2)",
      songs[0].slides[0].label === "Verse 1" && songs[0].slides[1].label === "Chorus" && songs[0].slides[2].label === "Verse 2"
    );
    check(
      "short chord brackets stripped, but [x2]-style repeat markers kept",
      songs[0].slides[1].lines[1] === "How great Thou art, how great Thou art [x2]" &&
        songs[0].slides[0].lines.every((l) => !/\[[A-G]/.test(l))
    );
    check("second song (no Sequence) falls back to numbered Verse labels", songs[1].slides[0].label === "Verse 1");
  }

  console.log("\n== parseSongs: videopsalm (batch-wrapped, unquoted keys) ==");
  {
    const songs = migration.parseSongs(readFixture("videopsalm-batch.json"), "videopsalm");
    check("one song extracted from the wrapped/unquoted-key batch export", songs.length === 1);
    check("title parsed despite unquoted JSON keys", songs[0].title === "Amazing Love");
    check(
      "<br> line breaks recovered as separate lines",
      songs[0].slides[0].lines.length === 2 && songs[0].slides[0].lines[0] === "Amazing love, how can it be"
    );
  }

  console.log("\n== parseSong: videopsalm-compressed throws a clear, actionable error ==");
  try {
    migration.parseSong("whatever", "videopsalm-compressed");
    check("parseSong throws for videopsalm-compressed", false);
  } catch (err) {
    check(
      "error message tells the operator to re-export uncompressed",
      err instanceof Error && /compressed/i.test(err.message) && /json/i.test(err.message)
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
    const result = await migration.importSongsFromDir(SONGS_FIXTURES_DIR);

    // 3 single-song files + 2 songs from videopsalm-songbook.json + 1 song from
    // videopsalm-batch.json = 6, even though it's only 5 well-formed *files*
    // (a VideoPsalm songbook file can contain more than one song).
    check("imported all songs across the 5 well-formed fixture files", result.imported.length === 6);
    check(
      "imported ids are as expected",
      [
        "amazing-grace",
        "great-is-thy-faithfulness",
        "it-is-well-with-my-soul",
        "how-great-thou-art",
        "blessed-assurance",
        "amazing-love",
      ].every((id) => result.imported.includes(id))
    );
    check(
      "malformed fixtures reported as errors, not thrown",
      result.errors.some((e) => e.file === "broken-no-title.xml") && result.errors.some((e) => e.file === "empty.xml")
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
    const result = await migration.importSongsFromDir(SONGS_FIXTURES_DIR);
    check("second import of same fixtures still imports all 6 songs", result.imported.length === 6);
    check(
      "collisions de-duplicated with -2 suffix",
      [
        "amazing-grace-2",
        "great-is-thy-faithfulness-2",
        "it-is-well-with-my-soul-2",
        "how-great-thou-art-2",
        "blessed-assurance-2",
        "amazing-love-2",
      ].every((id) => result.imported.includes(id))
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
