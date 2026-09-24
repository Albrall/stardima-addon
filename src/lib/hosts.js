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

// Some hosts (Goodstream via strema.top) hand back a tiny "validating" page with
// a form that must be POSTed before the real player HTML is returned.
function parseForm(html) {
  const m = html.match(/<form[^>]*action=["']([^"']+)["'][^>]*>([\s\S]*?)<\/form>/i);
  if (!m) return null;
  const action = m[1].replace(/&amp;/g, '&');
  const fields = {};
  const ire = /<input[^>]*>/gi; let i;
  while ((i = ire.exec(m[2]))) {
    const tag = i[0];
    const name = (tag.match(/name=["']([^"']+)["']/i) || [])[1];
    if (!name) continue;
    const val = (tag.match(/value=["']([^"']*)["']/i) || [])[1] || '';
    fields[name] = val.replace(/&amp;/g, '&');
  }
  return { action, fields };
}
async function submitForm(pageUrl, html, ms = 15000) {
  const f = parseForm(html);
  if (!f) return null;
  const action = normalizeUrl(new URL(f.action, pageUrl).href);
  const body = Object.entries(f.fields)
    .map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v)).join('&');
  try {
    const res = await fetchT(action, {
      method: 'POST',
      headers: {
        'User-Agent': UA, 'Referer': pageUrl, 'Accept': '*/*',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body, redirect: 'follow',
    }, ms);
    if (!res || !res.ok) return null;
    return { html: await res.text(), url: res.url || action };
  } catch (e) { return null; }
}

function pick(cand, referer) {
  if (cand.m3u8.length) return { url: cand.m3u8[0], type: 'hls', referer };
  if (cand.mp4.length) return { url: cand.mp4[0], type: 'mp4', referer };
  return null;
}
function scan(html, pageUrl) {
  const blob = unpackAll(html) + '\n' + html;
  const cand = extractCandidates(blob);
  let hit = pick(cand, new URL(pageUrl).origin + '/');
  if (hit) return hit;
  const inner = blob.match(/https?:\/\/[^"'\s\\<>]+?\/embed[^"'\s\\<>]*/i);
  return inner ? { inner: inner[0], html, pageUrl } : null;
}

// Resolve a host embed URL to a playable stream.
// Returns { url, type: 'hls'|'mp4', referer } or null.
async function resolveHost(embedUrl, depth = 0) {
  if (!embedUrl || depth > 2) return null;
  let html, effective = embedUrl;
  try {
    const res = await fetchT(embedUrl, {
      headers: { 'User-Agent': UA, 'Referer': 'https://v2.hyperwatching.com/', 'Accept-Language': 'en-US,en;q=0.9' },
      redirect: 'follow',
    }, 12000);
    html = await res.text();
    effective = res.url || embedUrl;
  } catch (e) { return null; }

  // 1) straight extraction (includes unpacking any packer)
  let r = scan(html, effective);
  if (r && r.url) return r;

  // 2) "validating" interstitial: POST the form, then extract from the player page
  if (/<form/i.test(html)) {
    const sub = await submitForm(effective, html);
    if (sub) {
      const r2 = scan(sub.html, sub.url);
      if (r2 && r2.url) return r2;
      if (r2 && r2.inner) return resolveHost(r2.inner, depth + 1);
      // player page may itself be a wrapper
      if (/<iframe|embed[^"']*\.html/i.test(sub.html)) {
        const m = sub.html.match(/(?:src|action)=["']([^"']*(?:embed|player)[^"']*)["']/i);
        if (m) return resolveHost(normalizeUrl(new URL(m[1], sub.url).href), depth + 1);
      }
    }
  }

  // 3) one level of inner-embed following
  if (r && r.inner && r.inner !== embedUrl) return resolveHost(r.inner, depth + 1);
  return null;
}

module.exports = { resolveHost, extractCandidates, normalizeUrl, UA };
