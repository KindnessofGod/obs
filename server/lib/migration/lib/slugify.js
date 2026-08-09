// Cap well under typical filesystem path-component limits (255 bytes) so an
// unusually long or non-Latin title (which strips down to very little after
// NFKD normalization, or expands unpredictably) can never produce an id that
// fails to write to disk with a cryptic ENAMETOOLONG.
const MAX_SLUG_LENGTH = 80;

// Turns a song title into a URL-safe id, e.g. "Amazing Grace" -> "amazing-grace".
function slugify(title) {
  const base = String(title || "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // strip accents/diacritics left behind by NFKD
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/^-+|-+$/g, "");
  return base || "song";
}

module.exports = { slugify };
