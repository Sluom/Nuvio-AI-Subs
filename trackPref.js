function urlKey(u) {
  const s = String(u || '').trim();
  if (!s) return '';
  try { return new URL(s).pathname.toLowerCase(); } catch (e) { return s.split('?')[0].toLowerCase(); }
}

function nameOf(item) {
  const raw = item && (item.name || item.fileName || item.title || item.origName);
  return String(raw || '').trim().slice(0, 200);
}

function makePinEntry(item) {
  return {
    url: item.url,
    _source: item._source || item._site || 'subdl',
    _site: item._site || item._source || 'subdl',
    name: nameOf(item)
  };
}

module.exports = {
  urlKey,
  nameOf,
  makePinEntry
};
