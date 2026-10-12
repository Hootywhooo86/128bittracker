// Just enough RSS reading for Letterboxd and Goodreads feeds.
export function rssItems(xml) {
  return [...String(xml).matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/g)].map((m) => m[1]);
}

/** Text of the first <name> tag (namespaced names like letterboxd:filmTitle work too). */
export function tag(xml, name) {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = String(xml).match(new RegExp(`<${esc}\\b[^>]*>([\\s\\S]*?)</${esc}>`));
  if (!m) return null;
  const raw = m[1].replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, '$1').trim();
  return decode(raw) || null;
}

export function decode(s) {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"').replace(/&apos;|&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}
