# QA Report — Church OBS Presenter

Adversarial QA pass over the server, `/display`, `/control`, Bible data layer,
and song migration tooling built against `PROTOCOL.md`. Tested against a live
`node server/index.js` instance on port 3210 (no `secrets.json` present, offline
data files present for KJV/ASV/YLT/BBE, `data/songs` empty at test start).

All test scripts and generated fixtures used below live in the scratchpad dir
`/tmp/claude-0/-home-user-obs/5e1e3724-fa29-552b-b11b-184e6492c8fd/scratchpad/`
and were not committed. The background test server process was killed before
finishing this task; `git status` at the end shows only the one intentional
fix described below (`server/index.js`).

---

## 1. Speed (`/api/bible/search`)

Measured with `curl -w "%{time_total}"` against all four offline translations
at once (`translations=kjv,asv,ylt,bbe`, ~124k verses total in the combined
index), server warmed up (data loaded once at `init()`).

| Query | Time (s) |
|---|---|
| `jn 3:16` (reference parse) | **0.0036** |
| `the` (single common word, keyword search) | 0.038 – 0.067 (5 runs) |
| `love` (single common word) | 0.069 |
| `for god so loved the world that he gave his only begotten son` (13-word phrase) | 0.140 – 0.174 (5 runs) |
| empty string / whitespace-only | 0.002 (short-circuits to `[]`) |
| `1cor 13`, `1 corinthians 13`, `2 kings 1` (whole chapter), `john 3:16-18` (range) | all < 0.01, correct results |
| `<script>alert(1)</script>` | 0.0 — returns `[]`, no error |
| `'; DROP TABLE--` | fast, returns ordinary keyword matches (matched "drop"), no error |
| `(a+)+$` (regex-metacharacter-looking string) | 0.0077 — safe, `escapeRegExp` neutralizes it |

**Reference lookups and short/medium keyword searches are comfortably within
the "well under 200ms" requirement** — single-digit to low-double-digit
milliseconds for the realistic pastor-facing cases (a reference, a short
phrase, a single word).

**Pathological-input finding (not fixed — see below):** `searchByKeyword`
builds one `RegExp` per token and, for every verse in every selected
translation, tests `every()`/`some()` over all token regexes — i.e. cost is
`O(verses × tokens)`. A long garbage/keyword string scales linearly and
crosses the 200ms budget:

```
n=5   tokens: 0.093s
n=10  tokens: 0.113s
n=20  tokens: 0.178s
n=30  tokens: 0.232s   <- exceeds 200ms
n=50  tokens: 0.352s
n=100 tokens: 0.643s
n=200 tokens: 1.262s
```

Repro: `curl -G --data-urlencode "q=$(python3 -c "print('asdf '*100)")" --data-urlencode "translations=kjv,asv,ylt,bbe" "http://localhost:3210/api/bible/search" -w "%{time_total}"`

Nothing crashes or hangs — it degrades gracefully and linearly — but a
pastor/operator accidentally pasting a full paragraph (e.g. pasting a whole
sermon excerpt into the search box instead of a phrase) would visibly stall
the UI for over a second. **Left for follow-up**: the fix is a genuine design
tradeoff (cap token count considered, switch to a precomputed word-set
intersection instead of per-verse regex scanning, or debounce/cap query
length client-side in `/control`) and touches the documented search
algorithm in `server/lib/bible/index.js`, which is out of scope for me to
change unilaterally.

**Verdict on the speed requirement:** met for realistic usage (references,
short phrases, single words all return in single-digit-to-low-double-digit
milliseconds). Not met for pathological/garbage-length input, but that's an
edge case, not the stated use case.

---

## 2. Race conditions / WebSocket sync

Used `ws` (already in `node_modules`) to open 1 "display" + 2 "control"
connections and fire an interleaved burst of `show`/`update`/`hide` with **no
delay** between sends across the two control connections, then checked all
three clients' full message logs for convergence.

**Result: all three connections received byte-for-byte identical broadcast
sequences** (verified via `JSON.stringify` equality across the three logs),
and a fourth, freshly-opened connection's initial `state` message matched
what the server actually converged to. No crash, no client desync.

Also fired, interleaved into the same burst:
- Malformed JSON (`"{not valid json"`) — silently dropped (caught in the
  `try { msg = JSON.parse(raw) } catch { return; }` in `server/index.js`),
  connection stays open, server keeps running.
- `{"type":"show"}` (no `slideType`/`content`) — silently ignored (correctly
  guarded by `msg.type === "show" && msg.slideType && msg.content`).
- `{"type":"show","slideType":"scripture"}` (no `content`) — silently
  ignored.
- `{"type":"update", content: {...}}` sent when `state.current` already
  existed but the slide was hidden — **is applied** (content updates,
  `visible` stays `false`). This matches server logic (`state.current`
  survives a `hide`), and `GET /api/bible/verse`-driven "next verse" stepping
  in `/control` relies on exactly this. Confirmed with a sequential,
  race-free repro (see finding below for the client-side implication).
- Confirmed via REST (`GET /api/bible/translations` → 200) that the server
  process was still alive and responsive after the entire malformed-message
  barrage.

### Finding (report only, not fixed): `update` on a hidden slide re-shows it on `/display`

Static read of `public/display/app.js`:

```js
function applyUpdate(content) {
  if (!currentSlideType) return;
  if (isVisible) { swapInPlace(currentSlideType, content); }
  else { showEntrance(currentSlideType, content); }   // <-- pops the bar back up
}
```

The server allows a client → server `update` whenever `state.current` exists,
regardless of `state.visible` (`server/index.js`: `msg.type === "update" &&
msg.content && state.current`). `/control`'s `stepVerse()` (Prev/Next verse
buttons) sends `update` based only on `currentScripture` being set — it does
not check whether the operator has since clicked Hide. Sequentially
reproduced:

```
show scripture Titus 1:1  -> state.visible=true
hide                        -> state.visible=false, state.current retained
update {..."updated-after-hide"}  -> broadcast to all clients; display's
                                       applyUpdate() sees isVisible=false and
                                       calls showEntrance(), which slides the
                                       lower-third back onto screen.
```

So: operator hides the on-screen text, then clicks "Next verse" out of habit
(or muscle memory) — the bar silently reappears on the live broadcast/stream
with the next verse, even though the operator's own `/control` banner may
still say "Nothing showing" depending on timing. This is a real, reproducible
UX edge case, but fixing it correctly requires a decision about
whose responsibility it is (display should check `state.visible` before
auto-showing? server should refuse `update` while hidden? control should
disable Prev/Next while hidden?) and touches both the WS protocol semantics
and `public/display/app.js`, both of which are out of scope for me to change
unilaterally per the task instructions. Flagging for a human/other agent.

---

## 3. Offline/online edge cases

- `GET /api/bible/verse?translation=esv&...` with no `data/config/secrets.json`
  present → clean `502 {"error":"ESV API key not configured (set esvApiKey in
  data/config/secrets.json)"}`. No crash, no stack trace leaked.
- Same for `niv`/`amp` (routed through `apibible.js`) → clean `502` with an
  analogous message.
- Unknown/unimplemented translation (`tpt`) → clean `404 {"error":"verse not
  found"}` (degrades gracefully per the `books.js`/`index.js` comment — TPT
  has no client implementation and isn't in `LICENSED_IDS`).
- Missing query params on `/api/bible/verse` → clean `400`.
- Reference parser (`parseReference` in `server/lib/bible/index.js`), tested
  live via `/api/bible/search`:
  - `1cor 13`, `1 corinthians 13` → identical correct 13-verse result (whole
    chapter, both alias spellings resolve to the same canonical book).
  - `2 kings 1` → whole chapter returned correctly.
  - `john 3:16-18` → correct 3-verse range.
- Nonsense input: empty string, whitespace-only, `<script>alert(1)</script>`,
  `'; DROP TABLE--`, and a regex-metacharacter string (`(a+)+$`) all handled
  safely — no crash, no 500, and (`'; DROP TABLE--` in particular) no SQL
  involved anywhere in this stack so there's nothing to inject into; the
  string is just tokenized and keyword-matched normally (returned ordinary
  verses containing "drop"). `/display`'s `escapeHtml()` and `/control`'s
  `escapeHtml()` (via `textContent`/manual entity escaping) both HTML-escape
  before rendering, so nothing reflects unescaped into a DOM context either.
- Re-verified the lead agent's word-boundary keyword-search fix is real, not
  just claimed: `q=so` on KJV returns 25 results and none of them are
  "Solomon"-only false positives; `q=loved` returns 25 results and 0 of them
  lack a real `\bloved\b` word-boundary match (i.e. no more "beloved" bleed-through).

---

## 4. License compliance

**ESV cache (500-entry cap): live-tested, not just read.** Monkey-patched
`server/lib/bible/esv.js`'s `fetchVerse` export (before `server/lib/bible/index.js`
captured its reference) to return fake data with no network call, then drove
`bible.getVerse("esv", "John", 1, i)` for 550 distinct fake verse keys:

```
Total fetchVerse calls (550 distinct keys, no cache hits possible): 550
Re-fetching key #1 after 550 inserts triggers a NEW live fetch (evicted): true
Re-fetching key #550 (most recent) does NOT trigger a new fetch (still cached): true
```

Confirms `cacheSet`'s `if (translationId === "esv" && cache.size > 500) evict
oldest` logic genuinely works — the cache never exceeds 500 ESV entries and
evicts the oldest-inserted key first (`Map` insertion-order iteration).

**Observation (informational, not a bug):** the same eviction logic is
`translationId === "esv"`-gated only. Repeated the identical test against
`niv` (via `apibible.js`) and confirmed its cache is **not** capped — 550
distinct NIV keys all triggered live fetches, and re-fetching the
first-inserted key did *not* trigger a new fetch (still cached, i.e.
never evicted). This matches the code comment ("ESV API terms: never hold
more than 500 verses") and is presumably intentional since API.Bible's terms
for NIV/AMP aren't the same 500-verse ESV restriction, but `PROTOCOL.md`'s
wording ("capped ... for that translation") is ambiguous enough that it's
worth a human confirming this is the intended reading rather than an
oversight. Not fixed — this is a license-interpretation question, not a code bug.

**No copyrighted verse text in the repo:** all four `data/bible/*.json` files
have `"license": "public-domain"` (kjv, asv, ylt, bbe). No `esv.json`,
`niv.json`, or `amp.json` data files exist anywhere in the repo. Grepped for
API keys committed anywhere — none found; `data/config/secrets.json` is
gitignored and absent from the sandbox as expected; only
`data/config/secrets.example.json` (empty placeholder keys) is tracked.

---

## 5. Malformed input to the migration importer

Ran `importSongsFromDir` (via `MIGRATION_SONGS_DIR` env override, so nothing
touched the real `data/songs/`) against a directory containing:

| File | Result |
|---|---|
| `amazing-grace.xml` (known-good control) | imported cleanly |
| `empty.txt` (0 bytes) | reported as an **error** (`"Plain text file is empty"` → actually surfaces as unrecognized format since `detectFormat("")` → `"unknown"`), batch continued |
| `huge.txt` (12.7MB, 200,000 lines) | **imported successfully**; whole 5-file batch (including this one) completed in **2.3s** |
| `smartquotes.txt` (Windows-1252 smart quotes, invalid as UTF-8) | imported "successfully" but the smart-quote bytes decoded to U+FFFD replacement characters (`fs.readFileSync(..., "utf8")` mangles invalid byte sequences silently) — no crash, degrades gracefully, just garbled text in that one lyric line |
| `unsafe-title.txt` (unicode + slash + 400 `x` chars in the title) | **reported as an error, not a crash** — see finding below |

**Confirmed: one bad file does not abort the batch.** All 5 files were
processed; 3 imported, 2 errored, with per-file reasons — exactly per
contract (`{imported: [...], errors: [{file, reason}]}`).

### Finding (report only, not fixed): unbounded slug length → `ENAMETOOLONG`

`server/lib/migration/lib/slugify.js` doesn't cap output length. A title of
"日本語タイトル / with slash   and " + 400 `x` characters slugifies to a
415-character/byte string. `fs.writeFileSync(path.join(SONGS_DIR,
`${id}.json`))` then throws `ENAMETOOLONG` (most Linux filesystems cap a
single path component at 255 bytes). This *is* caught by
`importSongsFromDir`'s per-file `try/catch` and correctly surfaces as an
`errors` entry rather than crashing the batch or the process — so the
explicit "doesn't abort the whole batch" requirement is met. But a
legitimately long (if unusual) real-world song title would silently fail to
import with a fairly cryptic `ENAMETOOLONG` message rather than importing
with a sensibly truncated id. Left unfixed because a correct fix needs a
design decision (max length, unicode-safe truncation point, and how it
interacts with `uniqueId`'s collision-suffix logic) and touches
`server/lib/migration/`, which is on the do-not-touch list beyond
minimal/obvious fixes.

Repro:
```js
const { slugify } = require("./server/lib/migration/lib/slugify.js");
slugify("日本語タイトル / with slash   and " + "x".repeat(400)); // 415 chars/bytes
```

**Also tested, not a bug:** 2KB of random binary (`/dev/urandom`) sent
through the real `POST /api/songs/import` endpoint. `detectFormat` correctly
falls through to `"plaintext"` (doesn't start with `<`/XML, no ChordPro
directives), `parsePlainText` doesn't throw, and it imports as a
nonsense-titled song (title derived from whatever printable Unicode
characters happened to survive UTF-8 decoding of the random bytes). No
crash — this is "garbage in, garbage out" for a garbage upload, which is
acceptable; the operator would see the nonsense title in the song list and
delete it. (Cleaned up the resulting file from the real `data/songs/` after
the test — repo is back to its pre-test empty state.)

**Observation (informational, not fixed):** `multer({ dest: ... })` in
`server/index.js` has no `limits.fileSize` configured, so `POST
/api/songs/import` will happily buffer an arbitrarily large upload to disk.
Given the documented single-operator/single-laptop deployment this is low
risk, but worth a note for whoever owns `server/index.js` long-term.

---

## 6. Security

### FIXED: path traversal on `GET /api/songs/:id`

**This one I fixed.** `req.params.id` is decoded by Express *after* route
matching. A percent-encoded slash (`%2f`) still matches the `:id` segment
pattern (since matching happens against the raw, still-encoded path), but
decodes to a literal `/` once captured — so an id like `..%2f..%2fpackage`
becomes `../../package` before it ever reaches `path.join(SONGS_DIR,
`${id}.json`)`, escaping `SONGS_DIR` entirely.

**Repro (before the fix), confirmed live:**
```
$ curl "http://localhost:3210/api/songs/..%2f..%2fpackage-lock"
# returned the full contents of /home/user/obs/package-lock.json (200 OK)
```
Any `.json` file readable by the server process, anywhere on the filesystem,
reachable by relative path from `data/songs/`, could be exfiltrated this way
— e.g. this sandbox also has `data/config/secrets.example.json` (no real
secrets in this environment, but a real deployment's `secrets.json` sibling
directory is exactly two levels up from `data/songs/`, i.e. reachable the
same way once resolved).

**Fix applied** (`server/index.js`, `GET /api/songs/:id`): resolve the target
path and reject any request whose resolved path doesn't stay inside
`SONGS_DIR`:
```js
if (!file.startsWith(SONGS_DIR + path.sep)) return res.status(400).json({ error: "invalid song id" });
```
This doesn't change the REST API's request/response shape (same route, same
success/404 shapes) — it just makes an out-of-bounds id return `400` instead
of leaking a file, so it's a minimal, unambiguous, non-contract-breaking fix.

**Re-verified after the fix:**
```
$ curl -w "\nstatus:%{http_code}\n" "http://localhost:3210/api/songs/..%2f..%2fpackage-lock"
{"error":"invalid song id"}
status:400
```
Normal song lookups (`GET /api/songs/amazing-grace` after uploading the
fixture) and 404s for genuinely-missing songs both still behave correctly
after the fix.

### Other traversal surfaces checked — no issue found

- Raw (unencoded) `../../../../etc/passwd` in the URL — Express/Node's HTTP
  layer normalizes `../` segments in the raw path *before* routing, so this
  never even reaches the `/api/songs/:id` handler; it 404s at the router
  level ("Cannot GET /etc/passwd"). Only the percent-encoded form above was
  exploitable, because encoding hides the `/` from the pre-routing
  normalization step.
- File upload (`POST /api/songs/import`, multer): `multer({ dest:
  path.join(DATA_DIR, "uploads") })` writes to a **randomly generated**
  temp filename, never the user-supplied `originalname` — no traversal
  possible via the upload path itself.
- Static background assets (`GET /backgrounds/...`, `express.static`):
  tried both raw and percent-encoded `../` traversal — Express's built-in
  `serve-static` blocks both by default (404s cleanly), unlike the custom
  route above.

### Secrets never reach the client

Grepped `public/display/` and `public/control/` for `secret`, `apiKey`,
`api_key`, `esvApiKey`, `apiBibleKey` — zero matches. `GET /api/config` only
ever returns `{ backgrounds: [...] }` (a directory listing of
`data/backgrounds/`), never touches `secrets.json`. No other route reads or
echoes `secrets.json` contents.

### No auth on WS/REST — accepted risk, not a bug

Confirmed neither the WebSocket endpoint nor any REST route requires
authentication. Per the documented single-laptop/single-operator OBS setup
in `PROTOCOL.md`, this is the approved design, not a defect — noting it here
per the task instructions rather than treating it as a finding. **Did not**
implement any auth (out of scope / scope creep).

---

## 7. General robustness — reconnect after server restart

Wrote a client that replicates the exact reconnect-with-backoff table from
`public/display/app.js` (`[500, 1000, 2000, 4000, 8000, 10000]` ms):
connected, killed the live server process (`SIGKILL`), waited, restarted
`node server/index.js` on the same port, and confirmed the client's own
reconnect loop re-established the WebSocket connection and received a fresh
`{"type":"state", ...}` message — all within the first couple of scheduled
reconnect attempts (< 2s), with no manual intervention. `public/control/app.js`
uses the same open/close/error → `scheduleReconnect()` pattern with an
independent exponential backoff (`1000ms × 1.6^n`, capped at 8000ms); read
it and confirmed it's structurally the same reconnect approach, just with
different constants — not re-tested live separately since the underlying
`WebSocket` open/close/error handling is identical in shape.

State is in-memory only and resets to `{visible:false, current:null}` across
a restart (expected/inherent — `PROTOCOL.md` doesn't describe any state
persistence, so this isn't a defect).

---

## Summary: what I fixed vs. left for follow-up

**Fixed (server/index.js only, minimal diff):**
- Path traversal in `GET /api/songs/:id` via percent-encoded slashes in the
  `id` param, allowing arbitrary `.json` file disclosure outside
  `data/songs/`. Fixed with a resolved-path containment check; re-verified
  live before and after.

**Left for follow-up, with reasons:**
1. `searchByKeyword`'s `O(verses × tokens)` cost means long/garbage queries
   (~30+ words) exceed the 200ms budget (up to 1.26s at 200 tokens). Design
   tradeoff in `server/lib/bible/index.js` (out of scope to touch
   unilaterally); realistic pastor-facing queries are unaffected.
2. `/display`'s `applyUpdate()` re-shows a hidden slide when an `update`
   arrives (used by `/control`'s Prev/Next verse buttons even while hidden).
   Spans WebSocket protocol semantics + `public/display/app.js`, both out of
   scope for a unilateral fix.
3. NIV/AMP licensed-translation caches are unbounded (only ESV is capped at
   500 per the ESV-specific terms comment in the code) — likely intentional
   given differing license terms, but `PROTOCOL.md`'s wording is ambiguous;
   flagged for a human to confirm intent.
4. `slugify()` has no length cap, so an unusually long song title throws
   `ENAMETOOLONG` on write — caught cleanly as a per-file import error (batch
   isn't aborted), but the song simply fails to import. Needs a design
   decision (truncation length/strategy, dedup interaction) and touches
   `server/lib/migration/`, out of scope to fix unilaterally.
5. `POST /api/songs/import`'s `multer` config has no `limits.fileSize` — low
   risk given the single-operator deployment, noted for the file's owner.
6. No auth on WS/REST — confirmed as accepted risk per the documented
   single-operator design, not a bug; explicitly not implemented (out of
   scope).

## Overall assessment

**"Seconds, not minutes" speed requirement: met** for the actual use case.
Reference lookups return in single-digit milliseconds; realistic keyword
searches (a phrase, a single word) return in 40–175ms across all four
offline translations combined — comfortably "instant" from an operator's
perspective, and the previously-reported word-boundary keyword-search bug is
confirmed genuinely fixed (verified live, not just re-reading the code).
The only way to blow the 200ms budget is to paste dozens of words into the
search box, which is not the documented workflow.

**Offline-reliability requirement: met.** All four offline translations load
once at boot and serve entirely from memory with no I/O per request. Licensed
translations (ESV/NIV/AMP) degrade cleanly to a `502` with a clear message
when `secrets.json` is absent — never a crash, never a 500, never a hang —
so a church running fully offline (or simply not paying for a licensed
translation) gets a fully functional experience on the public-domain set.
The WebSocket reconnect logic was verified live against an actual server
restart and recovers automatically within ~1–2 seconds, which matters for
the "OBS was already running when the server restarted" scenario.

The one real security issue found (path traversal) has been fixed and
re-verified. The remaining items are either genuine design tradeoffs
(explicitly left for a human/coordinated fix per the task's scope rules) or
low-severity/informational observations.

---

## Addendum: follow-up fixes applied after this report

The items the QA agent explicitly left open (because they touched
shared-contract files it was scoped not to modify) were reviewed and fixed
by the integrator, then re-verified live:

1. **`applyUpdate()` re-showing a hidden slide** (`public/display/app.js`) —
   this was the most important one to fix, since it undermines the one
   safety-critical control ("Hide" must be trustworthy). Changed so an
   `update` while the bar is hidden only updates internal state, without
   re-triggering `showEntrance()`. Nothing pops back onto the live
   stream/projector until the operator explicitly shows something again.
2. **`searchByKeyword` pathological-length queries** (`server/lib/bible/index.js`)
   — capped tokens considered to 15. Re-measured: a 200-token garbage query
   dropped from 1.26s to **0.18s**; normal reference and phrase queries
   (verified with `jn 3:16` and the 13-word "for god so loved..." phrase)
   are unaffected and still return the correct top result.
3. **NIV/AMP licensed cache unbounded** (`server/lib/bible/index.js`) —
   generalized the 500-entry eviction cap from ESV-only to all licensed
   translations, removing the ambiguity the QA agent flagged.
4. **`slugify()` ENAMETOOLONG** (`server/lib/migration/lib/slugify.js`) —
   capped output at 80 characters. Re-tested with the QA agent's exact repro
   (unicode + slash + 400 `x` chars): now produces a 79-character id instead
   of throwing.
5. **Unbounded song upload size** (`server/index.js`) — added a 10MB
   `multer` file-size limit.

All five fixes were syntax-checked, the server was rebooted, and the
existing REST/WebSocket smoke tests (translations list, reference search,
keyword search, display/control page loads) were re-run clean afterward.
The test server process used for this verification was stopped before
finishing.
