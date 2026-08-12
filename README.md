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

The control dock has three tabs and one big "Hide / Clear" button that's
always visible no matter which tab you're on.

- **Scripture tab** — type a reference (`jn 3:16`, `john 3:16-18`, `1 cor 13`
  for a whole chapter) or keywords (`god so loved`) into the search box.
  Results appear as you type. Click a result — or just press Enter to show
  the top match instantly — and it's live on screen. Use Next/Previous to
  step through a passage without re-searching. The row of pill buttons above
  the search box picks **one** translation at a time (KJV, ASV, etc.) — click
  a different one and both the search and whatever verse is currently loaded
  instantly switch to it, no re-searching needed.
- **Songs tab** — type to filter your song list by title, click a song to
  open its slides (Verse 1, Chorus, etc.), click a slide to show it, use
  Next/Previous to step through in order.
- **Announcements tab** — click a saved announcement to show it, or type a
  title/body on the fly and hit "Show now" for something one-off.
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

1. In VideoPsalm, export your songs (VideoPsalm supports exporting in
   OpenSong-compatible format — check its Import/Export menu). Copy the
   exported files into a folder, e.g. `C:\Users\you\Desktop\my-songs`.
2. In the project folder, run:
   ```
   npm run import:songs -- C:\Users\you\Desktop\my-songs
   ```
   It reads every file in that folder (OpenSong XML, ChordPro, or plain text
   all work), parses out the title and verse/chorus structure, and adds each
   one to your song list. It prints a summary of what imported and flags
   anything it couldn't read so you can fix or re-export that one file.
3. Repeat any time you get new songs — it's safe to run again, it just adds
   what's new.

If your VideoPsalm export doesn't match cleanly (this was built and tested
against the standard OpenSong/ChordPro formats without a real VideoPsalm
sample file on hand — see `QA_REPORT.md` and the migration agent's notes),
send/share one exported song file so the parser can be tuned to the exact
format your VideoPsalm produces.

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
- The VideoPsalm song importer was built against VideoPsalm's documented
  OpenSong/ChordPro/plain-text export formats, not a real sample file from
  your installation — see §5 if an import doesn't come out right.
- See `QA_REPORT.md` for the full adversarial test pass: what was tested,
  what was found, what was fixed, and anything still open.
