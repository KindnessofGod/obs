#!/usr/bin/env node
// CLI wrapper around server/lib/migration's importSongsFromDir.
//
// Usage:
//   npm run import:songs -- <path-to-folder>
//
// Point it at a folder containing songs exported from VideoPsalm - either its own
// native Songbook JSON export (one file can contain the whole library), or OpenSong
// XML / ChordPro / plain text files (one song per file) - and it will parse each
// one and write data/songs/<id>.json per song found.

const path = require("path");
const fs = require("fs");

const migration = require("../server/lib/migration");

async function main() {
  const dirArg = process.argv[2];

  if (!dirArg) {
    console.error("Usage: npm run import:songs -- <path-to-folder>");
    console.error("       (point it at the folder where you copied your exported VideoPsalm song files)");
    process.exitCode = 1;
    return;
  }

  const dirPath = path.resolve(process.cwd(), dirArg);

  if (!fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) {
    console.error(`Not a directory: ${dirPath}`);
    process.exitCode = 1;
    return;
  }

  console.log(`Importing songs from: ${dirPath}\n`);

  const { imported, errors } = await migration.importSongsFromDir(dirPath);

  if (imported.length) {
    console.log(`Imported ${imported.length} song${imported.length === 1 ? "" : "s"}:`);
    for (const id of imported) console.log(`  - ${id}`);
  } else {
    console.log("Imported 0 songs.");
  }

  if (errors.length) {
    console.log(`\n${errors.length} file${errors.length === 1 ? "" : "s"} could not be imported:`);
    for (const { file, reason } of errors) console.log(`  - ${file}: ${reason}`);
  }

  console.log("\nDone." + (errors.length ? " Fix the files listed above and re-run to pick up the rest." : ""));

  if (errors.length && imported.length === 0) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error("Import failed:", err.message);
  process.exitCode = 1;
});
