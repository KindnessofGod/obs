# Church Presenter

A small OBS-native replacement for VideoPsalm. Instead of switching between two
separate programs during a live service, scripture, song lyrics, and
announcements show up as an on-screen lower-third graphic that lives **inside
OBS** — one Browser Source that goes to both the projector and the YouTube
stream, and one control panel docked inside the OBS window itself. You never
have to leave OBS.

See `PROTOCOL.md` for the technical contract (WebSocket/REST protocol, data
schemas, module interfaces) if you're modifying the code. This README is the
setup and day-to-day usage guide.

## 1. Requirements

- Windows 10/11 laptop (the one already running OBS).
- [Node.js](https://nodejs.org) 18 or newer — download the "LTS" installer
  from nodejs.org and run it once. That's the only thing that needs
  installing.
- OBS Studio 28+ (already installed, since you're already streaming).

## 2. First-time setup

1. Copy this whole project folder onto the church laptop (or `git clone` it if
   you're comfortable with that).
2. Open a terminal (PowerShell) in the project folder and run:
   ```
   npm install
   npm start
   ```
   You should see:
   ```
   Church presenter running: control http://localhost:3210/control  display http://localhost:3210/display
   ```
   Leave this window open — it's the local server. Closing it stops the whole
   system. (You can minimize it.)
3. In OBS:
   - **Add the display as a Browser Source** — in your live scene, click the
     `+` under Sources → Browser. Name it something like "Presenter". Set the
     URL to `http://localhost:3210/display/`, width/height to match your
     canvas (e.g. 1920x1080). Leave "Shutdown source when not visible"
     **unchecked**. Position/resize it to cover the full frame — the page
     itself is transparent except for the lower-third graphic, so it won't
     cover your camera.
   - **Add the control panel as a Custom Browser Dock** — in the OBS menu bar,
     go to View → Docks → Custom Browser Docks. Add one named "Presenter
     Control" with URL `http://localhost:3210/control/`. Click Apply, then
     drag the new dock to wherever's convenient in your OBS layout (e.g. next
     to the Scenes list). This dock is only visible to you — it never appears
     on stream or the projector.
4. That's the one-time setup. From now on: start the server (`npm start` in
   that folder, or double-click a shortcut to it — see "Starting it
   automatically" below), open OBS, and the dock + Browser Source connect
   automatically.

### Starting it automatically

To avoid opening a terminal every service, create a shortcut that runs
`npm start` for you: right-click in the project folder → New → Text Document,
rename it `start.bat`, edit it (right-click → Edit) and put in:

```bat
@echo off
cd /d "%~dp0"
npm start
```

Save it, and double-click `start.bat` before opening OBS each service.

## 3. Using it during service

The control dock has four tabs, a persistent "staged" strip with a big
**Display Live** button, and one always-visible "Hide / Clear" button — no
matter which tab you're on.

**Select first, then go live.** Clicking a scripture result, a song slide, or
an announcement never puts it on screen by itself — it only *stages* it (shown
in the strip right below the live banner). Nothing changes on the
projector/stream until you click **Display Live**. This is deliberate: you can
line up the next verse or song while something else is still showing, check it
in the Preview tab, and only then commit it.

- **Scripture tab** — type a reference (`jn 3:16`, `john 3:16-18`, `1 cor 13`
  for a whole chapter) or keywords (`god so loved`) into the search box.
  Results appear as you type. Click a result — or press Enter to stage the top
  match — to stage it, then click **Display Live** to put it on screen. Once
  it's live, Next/Previous steps through the passage live in real time (no
  extra clicks needed); if it's only staged (not live yet), Next/Previous just
  updates the preview instead. The row of pill buttons above the search box
  picks **one** translation at a time (KJV, ASV, etc.) — switching translation
  updates whatever verse you currently have selected, live or staged.
- **Songs tab** — type to filter your song list by title, click a song to open
  its slides (Verse 1, Chorus, etc.) and stage the first one automatically.
  Click any slide to stage it, or use Next/Previous — same live-vs-staged
  behavior as Scripture: instant live stepping once it's actually on screen,
  silent preview updates before that.
- **Announcements tab** — click a saved announcement, or type a title/body and
  hit "Stage", then confirm with **Display Live**.
- **Preview tab** — shows exactly what's staged, rendered with your real
  background graphic and text size, before it ever touches the
  projector/stream. This is the "does it look right" check.
- **Display Live** (in the strip below the live banner, visible on every tab)
  — puts whatever's currently staged on screen. Disabled when nothing's
  staged.
- **Hide / Clear** — kills whatever's currently on screen immediately, from
  any tab. Use this the moment the pastor moves on.
- **Text size (A− / A+ next to Hide)** — bumps the on-screen text bigger or
  smaller in 10% steps (70%–160%), applies instantly to whatever's live and
  to everything you show afterward. Your choice is remembered for next time.
- **Background** — each tab has its own "Background" dropdown, listing every
  image/video you've dropped into `data/backgrounds/`. Pick one per tab
  (scripture, songs/lyrics, and announcements remember their own choice
  separately). If there's only one file in that folder it's auto-selected the
  first time you open the app, so if you only have one lower-third graphic
  you likely won't need to touch this at all.

**If a click ever seems to do nothing**: check the connection dot next to
"Hide / Clear". If it says "reconnecting… (n pending)", the app noticed it
lost its connection (e.g. OBS reloaded the dock) — whatever you clicked is
queued and will go through the instant it reconnects, usually within a couple
of seconds. It's no longer silently dropped.

## 4. Bible translations

Four public-domain translations are bundled and work **fully offline**, no
setup needed: **KJV**, **ASV**, **YLT**, **BBE** (~31,000 verses each, real
full text — see `scripts/import-bible.js` if you ever want to re-run the
import or add another public-domain translation).

Popular copyrighted translations — **ESV, NIV, Amplified (AMP)** — need your
own free API key, because their text can't legally be bundled into this repo
(see `PROTOCOL.md` for the reasoning). Since the laptop already has internet
during service (you're streaming to YouTube), this works fine — the app
fetches the verse live the first time and remembers it for the rest of the
service so repeat lookups are instant.

To enable them:

1. **ESV**: go to https://api.esv.org/, sign up for a free account, and
   create an API key under "Applications" (non-commercial/ministry use is
   explicitly free — no cost).
2. **NIV / Amplified**: go to https://scripture.api.bible/, create a free
   account, register an application to get an API key, and request access to
   the specific translations you want (availability depends on their
   approval for your account).
3. Copy `data/config/secrets.example.json` to `data/config/secrets.json` and
   paste your keys in:
   ```json
   { "esvApiKey": "your-esv-key-here", "apiBibleKey": "your-api-bible-key-here" }
   ```
4. Restart the server (`npm start`). The translations now appear as options
   in the Scripture tab.

**TPT (The Passion Translation)** has no known free official API, so it isn't
included. If you need to show a TPT verse, you can always paste text manually
in the Announcements tab as a one-off ("compose on the fly").

## 5. Migrating your songs from VideoPsalm

Two ways to export from VideoPsalm, both supported directly — you don't need
to convert anything by hand:

- **VideoPsalm's own Songbook export** (Songbook menu → Export/Backup) — a
  single `.json` file that can contain your *entire* song library at once.
  Make sure **"Compressed" is unchecked** when you export — a compressed
  `.vpc` file isn't readable as text, and importing one will give you a clear
  error telling you to re-export instead of garbled text.
- **OpenSong-compatible export** (Import/Export menu) — one file per song, as
  OpenSong XML, ChordPro, or plain text.

Either way:

1. Copy the exported file(s) into a folder, e.g. `C:\Users\you\Desktop\my-songs`.
2. In the project folder, run:
   ```
   npm run import:songs -- C:\Users\you\Desktop\my-songs
   ```
   It reads every file in that folder, detects its format automatically, and
   adds every song it finds to your song list (a single Songbook file can add
   dozens of songs in one go). It prints a summary of what imported and flags
   anything it couldn't read so you can fix or re-export that one file.
3. Repeat any time you get new songs — it's safe to run again, it just adds
   what's new (same-titled songs get a `-2` suffix rather than overwriting).

The Songbook-format importer was built against VideoPsalm's real JSON export
structure (verified against the open-source FreeShow project's working
VideoPsalm importer), but hasn't been tested against a real file from this
specific installation yet. **Try it on a small handful of songs first**
before importing your whole library, and check that the lyrics/verse order
look right in the Songs tab. If something comes out wrong, share the
problem song's raw JSON entry (or the whole file, if it's not sensitive) and
it can be tuned to match exactly.

## 6. Migrating your backgrounds

See `data/backgrounds/README.md` — short version: copy your VideoPsalm
background images/videos into the `data/backgrounds` folder (`.png`, `.jpg`,
`.gif`, `.webp`, `.svg`, `.mp4`, `.webm`, or `.mov`), then restart the server
(`npm start`) so it picks up the new file. They then show up as choices in
the "Background" dropdown on each tab of the control panel — see §3.

## 7. Known limitations

- Built and tested for **one laptop, one operator** (per your setup). Not
  designed for multiple operators on separate machines over a network.
- TPT isn't available (no free API) — see §4.
- The VideoPsalm Songbook importer was built against a real open-source
  reference implementation (not guessed), but not yet verified against a real
  export from your specific installation/version — see §5 if an import
  doesn't come out right.
- See `QA_REPORT.md` for the full adversarial test pass: what was tested,
  what was found, what was fixed, and anything still open.
