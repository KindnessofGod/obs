// Parser for the ChordPro format: plain-text lyrics with inline chords in square
// brackets (e.g. "Amazing [C]grace, how [F]sweet the [C]sound") and metadata/section
// boundaries expressed as curly-brace directives, e.g. {title: Amazing Grace},
// {start_of_chorus}/{soc} ... {end_of_chorus}/{eoc}.
//
// Reference: the ChordPro directive vocabulary (https://www.chordpro.org/chordpro/chordpro-directives/)
// documents {title}/{t}, {start_of_chorus}/{soc}, {end_of_chorus}/{eoc}, and the
// verse/bridge/tab equivalents used below. This project's egress proxy blocked live
// access to chordpro.org during development, so this list is applied from prior
// knowledge of the format rather than a freshly re-verified fetch - see report.

const DIRECTIVE_RE = /^\{\s*([a-zA-Z_][\w-]*)\s*(?::\s*([\s\S]*?)\s*)?\}\s*$/;

const TITLE_DIRECTIVES = new Set(["title", "t"]);

const SECTION_STARTS = {
  start_of_chorus: "chorus",
  soc: "chorus",
  start_of_verse: "verse",
  sov: "verse",
  start_of_bridge: "bridge",
  sob: "bridge",
  start_of_tab: "tab",
  sot: "tab",
};

const SECTION_ENDS = {
  end_of_chorus: "chorus",
  eoc: "chorus",
  end_of_verse: "verse",
  eov: "verse",
  end_of_bridge: "bridge",
  eob: "bridge",
  end_of_tab: "tab",
  eot: "tab",
};

function stripChords(line) {
  return line
    .replace(/\[[^\]]*\]/g, "")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function labelWord(kind) {
  return kind.charAt(0).toUpperCase() + kind.slice(1);
}

function parseChordPro(fileContents) {
  const normalized = String(fileContents).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = normalized.split("\n");

  let title = null;
  const slides = [];
  const sectionCounts = {};
  let current = null; // { label, lines, explicit }

  const labelFor = (kind) => {
    sectionCounts[kind] = (sectionCounts[kind] || 0) + 1;
    const word = labelWord(kind);
    return sectionCounts[kind] === 1 ? word : `${word} ${sectionCounts[kind]}`;
  };

  const flush = () => {
    if (current && current.lines.length) slides.push({ label: current.label, lines: current.lines });
    current = null;
  };

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    const directiveMatch = trimmed.match(DIRECTIVE_RE);

    if (directiveMatch) {
      const name = directiveMatch[1].toLowerCase();
      const value = directiveMatch[2];

      if (TITLE_DIRECTIVES.has(name)) {
        if (value && !title) title = value.trim();
        continue;
      }
      if (SECTION_STARTS[name]) {
        flush();
        current = { label: labelFor(SECTION_STARTS[name]), lines: [], explicit: true };
        continue;
      }
      if (SECTION_ENDS[name]) {
        flush();
        continue;
      }
      // Other directives (subtitle, key, capo, tempo, comment, meta, ...) carry no
      // lyric content for our purposes - ignore them.
      continue;
    }

    if (!trimmed) {
      // Blank line: only ends an *implicit* block (one not opened by an explicit
      // start_of_*/soc directive) - explicit sections keep collecting until their
      // matching end directive so a blank line inside a chorus doesn't split it.
      if (current && !current.explicit) flush();
      continue;
    }

    const text = stripChords(rawLine);
    if (!current) {
      current = { label: labelFor("verse"), lines: [], explicit: false };
    }
    if (text) current.lines.push(text);
  }
  flush();

  if (!title) {
    for (const rawLine of lines) {
      const trimmed = rawLine.trim();
      if (!trimmed || DIRECTIVE_RE.test(trimmed)) continue;
      const text = stripChords(rawLine);
      if (text) {
        title = text;
        break;
      }
    }
  }

  if (!title) {
    throw new Error("ChordPro file has no {title:...} directive and no lyric line to infer a title from");
  }
  if (slides.length === 0) {
    throw new Error("ChordPro file has no usable lyric content");
  }

  return { title, slides };
}

module.exports = { parseChordPro };
