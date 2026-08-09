// Parser for the simplest VideoPsalm-compatible import: a plain .txt file.
//   - The first non-blank line is the song title.
//   - Everything after that is split into blank-line-separated blocks; each block
//     becomes one slide.
//   - Blocks are labelled "Verse 1", "Verse 2", ... in order, UNLESS a line that is
//     literally "Chorus" (case-insensitive, on a line by itself) appears immediately
//     above the block - either as its own standalone block, or as the block's first
//     line - in which case that block is labelled "Chorus" instead and the counter
//     used for "Verse N" is left untouched.

function parsePlainText(fileContents) {
  const normalized = String(fileContents).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = normalized.split("\n");

  let idx = 0;
  while (idx < lines.length && !lines[idx].trim()) idx++;
  if (idx >= lines.length) {
    throw new Error("Plain text file is empty");
  }
  const title = lines[idx].trim();

  // Group the remaining lines into blank-line-separated blocks.
  const blocks = [];
  let block = [];
  for (const line of lines.slice(idx + 1)) {
    if (!line.trim()) {
      if (block.length) {
        blocks.push(block);
        block = [];
      }
      continue;
    }
    block.push(line);
  }
  if (block.length) blocks.push(block);

  const slides = [];
  let verseCounter = 0;
  let nextIsChorus = false;

  for (const rawBlock of blocks) {
    const firstLine = rawBlock[0].trim();
    const firstLineIsChorusMarker = /^chorus$/i.test(firstLine);

    if (firstLineIsChorusMarker && rawBlock.length === 1) {
      // Standalone "Chorus" marker block - labels the *next* block, produces no slide itself.
      nextIsChorus = true;
      continue;
    }

    let label;
    let contentLines = rawBlock;
    if (firstLineIsChorusMarker && rawBlock.length > 1) {
      label = "Chorus";
      contentLines = rawBlock.slice(1);
    } else if (nextIsChorus) {
      label = "Chorus";
    } else {
      verseCounter += 1;
      label = `Verse ${verseCounter}`;
    }
    nextIsChorus = false;

    const trimmedLines = contentLines.map((l) => l.trim()).filter((l) => l.length > 0);
    if (trimmedLines.length) slides.push({ label, lines: trimmedLines });
  }

  if (slides.length === 0) {
    throw new Error("Plain text file has a title but no verse/chorus content beneath it");
  }

  return { title, slides };
}

module.exports = { parsePlainText };
