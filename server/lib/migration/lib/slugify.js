// Turns a song title into a URL-safe id, e.g. "Amazing Grace" -> "amazing-grace".
function slugify(title) {
  const base = String(title || "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // strip accents/diacritics left behind by NFKD
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return base || "song";
}

module.exports = { slugify };
