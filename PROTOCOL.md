# Internal protocol & module contracts

This document is the shared contract between the server, the `/display` page, the `/control` page, the Bible data layer, and the migration tooling. Every piece is built against this so the parts integrate without surprises.

## Runtime layout

- `server/index.js` — Express app + WebSocket server (single process, `npm start`, default port `3210`).
- `server/lib/bible/` — offline + licensed Bible data layer (owns its own contract below).
- `server/lib/migration/` — VideoPsalm/song import tooling (owns its own contract below).
- `public/display/` — served at `GET /display`, added to OBS as a **Browser Source**.
- `public/control/` — served at `GET /control`, added to OBS as a **Custom Browser Dock**.
- `data/songs/*.json` — one file per song (schema below).
- `data/announcements/announcements.json` — array of announcement slides.
- `data/config/config.json` — non-secret app config (enabled translation ids, background file names). **Never put API keys here.**
- `data/config/secrets.json` — gitignored, holds `{ "esvApiKey": "...", "apiBibleKey": "..." }`. Loaded by `server/lib/bible`. Missing file = licensed translations simply unavailable, offline ones still work.

## WebSocket protocol

One shared endpoint: `ws://localhost:3210/ws`. Every `/display` and `/control` page connects to it. Messages are JSON objects with a `type` field.

### Server → client (broadcast to all connected clients, both display and control)

```jsonc
// Sent immediately on connect, so a late-joining /display (e.g. OBS just started) or a
// second /control window syncs to current state without asking.
{ "type": "state", "visible": true, "current": { "slideType": "scripture", "content": { ... } } }

// Sent whenever the operator shows a new slide.
{ "type": "show", "slideType": "scripture" | "lyric" | "announcement", "content": { ... } }

// Sent to update the currently-visible slide's content without a hide/show flicker
// (e.g. "next verse", advancing a song to the next line block).
{ "type": "update", "content": { ... } }

// Sent when the operator hides the on-screen text.
{ "type": "hide" }

// Sent whenever the operator changes the global on-screen text size.
// scale is a multiplier applied to every slide type's font sizes (1 = 100%,
// clamped server-side to 0.7-1.6). Included in the initial `state` message
// too, so late-joining clients (a fresh /display, a second /control window)
// pick up whatever the last-set value was.
{ "type": "textScale", "scale": 1.2 }
```

`content` shape depends on `slideType`:

```jsonc
// slideType: "scripture"
{ "reference": "John 3:16", "translation": "KJV", "text": "For God so loved the world..." }

// slideType: "lyric"
{ "songTitle": "Amazing Grace", "slideLabel": "Verse 1", "lines": ["Amazing grace, how sweet the sound", "..."] }

// slideType: "announcement"
{ "title": "Potluck Next Sunday", "body": "Bring a dish to share after the second service." }
```

### Client → server

Only `/control` sends these; the server validates then re-broadcasts the corresponding `show`/`update`/`hide` message to everyone (including back to the sender, so all control windows/OBS docks stay in sync if more than one is open).

```jsonc
{ "type": "show", "slideType": "scripture" | "lyric" | "announcement", "content": { ... } }
{ "type": "update", "content": { ... } }
{ "type": "hide" }
{ "type": "textScale", "scale": 1.2 }
```

## REST API (used by `/control` for search/lookup; `/display` only uses the WebSocket)

- `GET /api/bible/translations` → `[{ "id": "kjv", "name": "King James Version", "source": "offline" | "esv" | "apibible", "licensed": false }]`
- `GET /api/bible/search?q=<text>&translations=kjv,web` → instant results for **offline** translations (reference parse like `"jn 3:16"`, `"john 3:16-18"`, or keyword search like `"god so loved"`). Returns `[{ "translation": "kjv", "book": "John", "chapter": 3, "verse": 16, "text": "..." }]`. Must return in well under 200ms for the whole offline Bible.
- `GET /api/bible/verse?translation=<id>&book=<book>&chapter=<n>&verse=<n>` → single verse, works for both offline and licensed translations (fetches + caches licensed ones transparently). `{ "translation": "esv", "book": "John", "chapter": 3, "verse": 16, "text": "...", "source": "cache" | "live" | "offline" }`
- `GET /api/songs` → `[{ "id": "amazing-grace", "title": "Amazing Grace" }]`
- `GET /api/songs/:id` → full song, see schema below
- `POST /api/songs/import` (multipart file upload, field name `file`) → runs the migration importer on an uploaded VideoPsalm/OpenSong/ChordPro/plain-text file, returns `{ "imported": ["amazing-grace"], "errors": [] }`
- `GET /api/announcements` → array of announcement slide objects
- `POST /api/announcements` → create/update an announcement slide, body `{ "title": "...", "body": "..." }`

## Data schemas

### Song (`data/songs/<id>.json`)

```jsonc
{
  "id": "amazing-grace",
  "title": "Amazing Grace",
  "slides": [
    { "label": "Verse 1", "lines": ["Amazing grace, how sweet the sound", "That saved a wretch like me"] },
    { "label": "Verse 2", "lines": ["..."] }
  ]
}
```

### Offline Bible translation (`data/bible/<id>.json`)

```jsonc
{
  "id": "kjv",
  "name": "King James Version",
  "license": "public-domain",
  "books": {
    "John": [
      ["In the beginning was the Word...", "..."],   // chapter 1, index 0 = verse 1
      ["..."]                                          // chapter 2
    ]
  }
}
```

## Module contract: `server/lib/bible`

```js
// server/lib/bible/index.js
async function init(); // loads all data/bible/*.json into memory, loads data/config/secrets.json if present
function listTranslations(); // -> [{id, name, source, licensed}]
function searchOffline(query, translationIds); // sync, -> [{translation, book, chapter, verse, text}]
async function getVerse(translationId, book, chapter, verse); // handles offline lookup AND licensed fetch+cache transparently
module.exports = { init, listTranslations, searchOffline, getVerse };
```

Licensed clients (ESV, API.Bible) live under `server/lib/bible/esv.js` and `server/lib/bible/apibible.js`, each exporting `async function fetchVerse(book, chapter, verse)`. `index.js` calls into these only when `translationId` isn't an offline one, and caches results in an in-memory `Map` for the life of the process — capped so it never holds more than the ESV terms allow (500 verses) for that translation.

## Module contract: `server/lib/migration`

```js
// server/lib/migration/index.js
function detectFormat(fileContents, filename); // -> "opensong" | "chordpro" | "plaintext" | "unknown"
function parseSong(fileContents, format); // -> { title, slides: [{label, lines}] }
async function importSongsFromDir(dirPath); // parses every file in dirPath, writes data/songs/<id>.json, -> {imported: [...ids], errors: [{file, reason}]}
module.exports = { detectFormat, parseSong, importSongsFromDir };
```

Also exposes background-asset intake: any image/video dropped in `data/backgrounds/` is picked up by `/api/config` and offered in `/control` as a background choice per slide type (scripture vs. lyric vs. announcement each remember their own last-picked background).

Backgrounds are **not** assumed to share one fixed shape — `/display` measures each image's real pixel dimensions on first load (`naturalWidth`/`naturalHeight`) and sizes the lower-third bar to that exact aspect ratio (via CSS `aspect-ratio`), so a scripture background at e.g. 1080×207 and a worship/lyric background at e.g. 1456×285 each render at their own true proportions edge-to-edge, never stretched or cropped into a guessed shape.
