// Generic stream extractor for the third-party video hosts that hyperwatching
// embeds (Lulustream, Mixdrop, Uqload, Goodstream/strema, Streamhg/hgcloud, etc).
// Strategy: fetch the host embed page, unpack any Dean Edwards packer, then
// search the unpacked + raw HTML for an HLS (.m3u8) or progressive (.mp4) URL.

const { unpackAll } = require('./unpacker');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function normalizeUrl(u) {
  if (!u) return null;
  u = u.trim().replace(/\\\//g, '/'); // unescape \/
  if (u.startsWith('//')) u = 'https:' + u;
  return u;
}

// Pull candidate stream URLs out of a blob of (unpacked) JS/HTML.
function extractCandidates(blob) {
  const found = { m3u8: [], mp4: [] };
  // Direct URLs
  for (const m of blob.matchAll(/https?:\/\/[^"'\s\\<>]+?\.m3u8[^"'\s\\<>]*/g)) found.m3u8.push(m[0]);
  for (const m of blob.matchAll(/https?:\/\/[^"'\s\\<>]+?\.mp4[^"'\s\\<>]*/g)) found.mp4.push(m[0]);
  // Protocol-relative URLs (e.g. mixdrop wurl = //host/file.mp4?...)
  for (const m of blob.matchAll(/["'(]\/\/[^"'\s\\<>]+?\.mp4[^"'\s\\<>]*/g)) found.mp4.push(normalizeUrl(m[0].slice(1)));
  for (const m of blob.matchAll(/["'(]\/\/[^"'\s\\<>]+?\.m3u8[^"'\s\\<>]*/g)) found.m3u8.push(normalizeUrl(m[0].slice(1)));
  // Common JS variable patterns
  const varPatterns = [
    /wurl\s*[:=]\s*["']([^"']+)["']/g,
    /furl\s*[:=]\s*["']([^"']+)["']/g,
    /\bfile\s*[:=]\s*["']([^"']+\.(?:m3u8|mp4)[^"']*)["']/g,
    /\bsrc\s*[:=]\s*["']([^"']+\.(?:m3u8|mp4)[^"']*)["']/g,
    /["']?(?:hls_?url|stream_?url|video_?url|playlist)["']?\s*[:=]\s*["']([^"']+\.(?:m3u8|mp4)[^"']*)["']/gi,
  ];
  for (const re of varPatterns) {
    for (const m of blob.matchAll(re)) {
      const u = normalizeUrl(m[1]);
      if (!u) continue;
      if (u.includes('.m3u8')) found.m3u8.push(u);
      else if (u.includes('.mp4')) found.mp4.push(u);
    }
  }
  found.m3u8 = [...new Set(found.m3u8.filter(Boolean))];
  found.mp4 = [...new Set(found.mp4.filter(Boolean))];
  return found;
}

// fetch with a hard timeout so a hung embed fails fast (caller can retry/next server)
async function fetchT(url, opts = {}, ms = 12000) {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ctrl.signal }); }
  finally { clearTimeout(to); }
}

// Resolve a host embed URL to a playable stream.
// Returns { url, type: 'hls'|'mp4', referer } or null.
async function resolveHost(embedUrl) {
  const origin = new URL(embedUrl).origin + '/';
  let html;
  try {
    const res = await fetchT(embedUrl, {
      headers: { 'User-Agent': UA, 'Referer': 'https://v2.hyperwatching.com/', 'Accept-Language': 'en-US,en;q=0.9' },
      redirect: 'follow',
    }, 12000);
    html = await res.text();
  } catch (e) {
    return null;
  }
  const unpacked = unpackAll(html);
  const blob = unpacked + '\n' + html;
  const cand = extractCandidates(blob);

  // Prefer HLS (adaptive, what Stremio/Nuvio players handle best), then MP4.
  if (cand.m3u8.length) return { url: cand.m3u8[0], type: 'hls', referer: origin };
  if (cand.mp4.length) return { url: cand.mp4[0], type: 'mp4', referer: origin };

  // Some hosts (Goodstream via strema.top/embed2?id=REAL) wrap another embed.
  // Try to follow an inner embed URL one level deep.
  const inner = html.match(/https?:\/\/[^"'\s\\<>]+?embed[^"'\s\\<>]*/i) ||
                blob.match(/https?:\/\/(?:goodstream\.one|strema\.top)\/[^"'\s\\<>]+/i);
  if (inner && inner[0] !== embedUrl) {
    const deep = await resolveHost(inner[0]);
    if (deep) return deep;
  }
  return null;
}

module.exports = { resolveHost, extractCandidates, normalizeUrl, UA };
