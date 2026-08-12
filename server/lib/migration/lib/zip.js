// Minimal, dependency-free ZIP reader - just enough to extract entries from a
// simple archive like VideoPsalm's "Compressed" .vpc songbook export (a plain
// ZIP with deflate compression, confirmed against a real exported file: one
// .json entry, no encryption, no zip64, no spanning). Not a general-purpose
// ZIP library - unsupported/unusual archives raise a clear error rather than
// silently producing wrong data.

const zlib = require("zlib");

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;
const EOCD_MIN_SIZE = 22;
const MAX_COMMENT_LENGTH = 65535;

function findEndOfCentralDirectory(buffer) {
  const scanFrom = Math.max(0, buffer.length - EOCD_MIN_SIZE - MAX_COMMENT_LENGTH);
  for (let i = buffer.length - EOCD_MIN_SIZE; i >= scanFrom; i--) {
    if (buffer.readUInt32LE(i) === EOCD_SIGNATURE) return i;
  }
  return -1;
}

function readCentralDirectoryEntries(buffer, eocdOffset) {
  const entryCount = buffer.readUInt16LE(eocdOffset + 10);
  let offset = buffer.readUInt32LE(eocdOffset + 16);

  const entries = [];
  for (let i = 0; i < entryCount; i++) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== CENTRAL_DIRECTORY_SIGNATURE) {
      throw new Error("malformed central directory record");
    }
    const compressionMethod = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localHeaderOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString("utf8", offset + 46, offset + 46 + nameLength);

    entries.push({ name, compressionMethod, compressedSize, localHeaderOffset });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function readEntryData(buffer, entry) {
  const lo = entry.localHeaderOffset;
  if (lo + 30 > buffer.length || buffer.readUInt32LE(lo) !== LOCAL_FILE_HEADER_SIGNATURE) {
    throw new Error(`malformed local file header for "${entry.name}"`);
  }
  const nameLength = buffer.readUInt16LE(lo + 26);
  const extraLength = buffer.readUInt16LE(lo + 28);
  const dataStart = lo + 30 + nameLength + extraLength;
  const compressed = buffer.subarray(dataStart, dataStart + entry.compressedSize);

  if (entry.compressionMethod === 0) return compressed; // stored, no compression
  if (entry.compressionMethod === 8) return zlib.inflateRawSync(compressed); // deflate
  throw new Error(`unsupported compression method ${entry.compressionMethod} for "${entry.name}"`);
}

/**
 * Reads a ZIP archive buffer -> [{ name, data: Buffer }, ...]
 */
function readZipEntries(buffer) {
  if (!Buffer.isBuffer(buffer)) throw new Error("expected a Buffer");
  const eocdOffset = findEndOfCentralDirectory(buffer);
  if (eocdOffset < 0) throw new Error("not a valid ZIP archive (no End Of Central Directory record found)");

  const entries = readCentralDirectoryEntries(buffer, eocdOffset);
  return entries.map((entry) => ({ name: entry.name, data: readEntryData(buffer, entry) }));
}

module.exports = { readZipEntries };
