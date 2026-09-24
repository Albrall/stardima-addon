// Stardima → Stremio/Nuvio addon server.
// Implements the Stremio addon protocol (manifest, catalog, meta, stream)
// plus an HLS/segment proxy so playback works regardless of IP-bound tokens
// or referer checks on the upstream video hosts.

const http = require('http');
const { URL } = require('url');
const stardima = require('./lib/stardima');
const resolver = require('./lib/resolver');
const { UA, resolveHost } = require('./lib/hosts');

const PORT = process.env.PORT || 7000;
const ADDON_ID = 'community.stardima.ar';
const VERSION = '1.0.0';

// ---------- tiny in-memory cache ----------
const cache = new Map();
function cacheGet(key, ttlMs) {
  const e = cache.get(key);
  if (e && Date.now() - e.t < ttlMs) return e.v;
  return null;
}
function cacheSet(key, v) { cache.set(key, { v, t: Date.now() }); }

// ---------- manifest ----------
const manifest = {
  id: ADDON_ID,
  version: VERSION,
  name: 'Stardima ستارديما',
  description: 'كرتون وأنمي مدبلج ومترجم من ستارديما — catalog + streaming addon.',
  logo: 'https://stardima-s7.cartoon.com.im/storage/branding/jIilPBoS046PwawHgt3EWYa1cj01pTgbEvumphDs.png',
  background: 'https://image.tmdb.org/t/p/original/9BhczLWHd0O9qOgBzO9dWKKH01a.jpg',
  resources: ['catalog', 'meta', 'stream'],
  types: ['series', 'movie'],
  idPrefixes: ['stardima:'],
  catalogs: [],
  behaviorHints: { adult: false, configurable: false },
};
const AR_NUM = ['١','٢','٣','٤','٥','٦','٧','٨','٩','١٠','١١','١٢','١٣','١٤','١٥'];
let _manifestCache = null; let _manifestCacheT = 0;
async function buildManifest() {
  if (_manifestCache && Date.now() - _manifestCacheT < 2 * 3600 * 1000) return _manifestCache;
  let lp = { series: 151, movie: 107 };
  try { lp = await stardima.getLastPages(); } catch (e) { /* fallback */ }
  const extra = [{ name: 'search', isRequired: false }, { name: 'skip', isRequired: false }];
  const catalogs = [];
  const sc = Math.ceil(lp.series / stardima.CHUNK_PAGES);
  const mc = Math.ceil(lp.movie / stardima.CHUNK_PAGES);
  for (let i = 0; i < sc; i++) catalogs.push({ type: 'series', id: 'stardima-s' + (i + 1), name: 'ستارديما · مسلسلات ' + (AR_NUM[i] || (i + 1)), extra });
  for (let i = 0; i < mc; i++) catalogs.push({ type: 'movie', id: 'stardima-m' + (i + 1), name: 'ستارديما · أفلام ' + (AR_NUM[i] || (i + 1)), extra });
  _manifestCache = Object.assign({}, manifest, { catalogs });
  _manifestCacheT = Date.now();
  return _manifestCache;
}


// ---------- proxy helpers ----------
function b64url(s) { return Buffer.from(s, 'utf8').toString('base64url'); }
function unb64url(s) { return Buffer.from(s, 'base64url').toString('utf8'); }

function addonBase(req) {
  const host = req.headers['x-forwarded-host'] || req.headers.host || 'localhost';
  let proto = (req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  if (!proto) proto = /^(localhost|127\.0\.0\.1|0\.0\.0\.0)/.test(host) ? 'http' : 'https';
  return `${proto}://${host}`;
}

// fetch with a hard timeout so a hung/slow CDN edge fails fast and the player
// can fall back to the next server instead of stalling.
async function fetchT(url, opts = {}, ms = 15000) {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ctrl.signal }); }
  finally { clearTimeout(to); }
}

// Build a proxied stream URL that routes through this addon.
function proxied(req, targetUrl, referer) {
  const base = addonBase(req);
  return `${base}/proxy?u=${b64url(targetUrl)}&r=${b64url(referer || '')}&t=${b64url(UA)}`;
}

// Rewrite an m3u8 playlist so every URI goes through our proxy.
function rewriteM3u8(playlistText, playlistUrl, referer) {
  const base = playlistUrl; // absolute URL of this playlist
  const lines = playlistText.split(/\r?\n/);
  const out = [];
  for (let line of lines) {
    const trimmed = line.trim();
    if (!trimmed) { out.push(line); continue; }
    if (trimmed.startsWith('#')) {
      // handle URI="..." inside tags (e.g. EXT-X-I-FRAME-STREAM-INF, EXT-X-KEY, SUBTITLES)
      line = line.replace(/URI="([^"]+)"/g, (m, uri) => {
        const abs = new URL(uri, base).href;
        return `URI="${proxiedRaw(abs, referer)}"`;
      });
      out.push(line);
      continue;
    }
    // a media/variant URI line
    const abs = new URL(trimmed, base).href;
    out.push(proxiedRaw(abs, referer));
  }
  return out.join('\n');
}
// proxy URL builder that doesn't need req (uses absolute addon base captured per-request)
let PROXY_BASE = '';
function proxiedRaw(targetUrl, referer) {
  return `${PROXY_BASE}/proxy?u=${b64url(targetUrl)}&r=${b64url(referer || '')}&t=${b64url(UA)}`;
}

// ---------- HTTP handlers ----------
function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}
function sendText(res, code, text, ctype) {
  res.writeHead(code, { 'Content-Type': ctype || 'text/plain; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
  res.end(text);
}

async function handleCatalog(req, res, type, id, query) {
  const search = query.search || query.query || '';
  const skip = parseInt(query.skip || '0', 10) || 0;
  const cacheKey = `cat:${type}:${id}:${search}:${skip}`;
  const cached = cacheGet(cacheKey, 10 * 60 * 1000);
  if (cached) return sendJson(res, 200, cached);
  try {
    let items;
    if (search) items = await stardima.searchCatalog(search);
    else {
      const mm = id.match(/^stardima-(s|m)(\d+)$/);
      const chunk = mm ? parseInt(mm[2], 10) - 1 : 0;
      items = await stardima.getCatalogChunk(type, chunk);
    }
    items = items.filter((it) => it.type === type);
    const metas = items.slice(skip, skip + 500).map((it) => ({
      id: 'stardima:' + it.slug,
      type,
      name: it.title,
      poster: it.poster,
      posterShape: 'regular',
      description: it.description || undefined,
      releaseInfo: it.year ? String(it.year) : undefined,
    }));
    const out = { metas };
    cacheSet(cacheKey, out);
    sendJson(res, 200, out);
  } catch (e) {
    sendJson(res, 500, { metas: [], error: e.message });
  }
}

async function handleMeta(req, res, type, id) {
  // id = stardima:{slug}
  const slug = id.replace(/^stardima:/, '');
  const cacheKey = `meta:${type}:${slug}`;
  const cached = cacheGet(cacheKey, 30 * 60 * 1000);
  if (cached) return sendJson(res, 200, cached);
  try {
    let meta;
    if (type === 'movie') {
      meta = await stardima.getMovieMeta(slug);
      meta.id = 'stardima:' + slug;
      // movies: expose a single video so some clients behave; stream uses meta id
    } else {
      meta = await stardima.getSeriesMeta(slug);
      meta.id = 'stardima:' + slug;
      meta.videos = (meta.videos || []).map((v) => ({
        id: 'stardima:' + slug + ':' + v.episodeId,
        title: v.title,
        season: v.season,
        episode: v.episode,
      }));
    }
    const out = { meta };
    cacheSet(cacheKey, out);
    sendJson(res, 200, out);
  } catch (e) {
    sendJson(res, 500, { meta: null, error: e.message });
  }
}

async function handleStream(req, res, type, id) {
  PROXY_BASE = addonBase(req);
  // For series: id = stardima:{slug}:{episodeId}
  // For movie:  id = stardima:{slug}  -> need to look up its episode id
  let episodeId = null;
  let movieSlug = null;
  const parts = id.split(':');
  if (type === 'series' && parts.length >= 2 && /^\d+$/.test(parts[parts.length - 1])) {
    episodeId = parts[parts.length - 1];
  } else if (type === 'movie') {
    // Movies play through /play/<slug>, which embeds the hyperwatching iframe.
    movieSlug = id.replace(/^stardima:/, '').split(':')[0];
  } else if (type === 'series') {
    const slug = parts[parts.length - 1];
    try {
      const m = await stardima.getSeriesMeta(slug);
      if (m.videos && m.videos[0]) episodeId = m.videos[0].episodeId || String(m.videos[0].id).split(':').pop();
    } catch (e) { /* none */ }
  }

  if (!episodeId && !movieSlug) return sendJson(res, 200, { streams: [] });

  // Cache the ORDERED SERVER LIST (stable), not the m3u8 (short-lived token).
  const cacheKey = movieSlug ? `movieservers:${movieSlug}` : `servers:${episodeId}`;
  let result = cacheGet(cacheKey, 10 * 60 * 1000);
  if (!result) {
    try {
      result = movieSlug ? await resolver.getMovieServers(movieSlug) : await resolver.getServers(episodeId);
    } catch (e) { return sendJson(res, 200, { streams: [], error: e.message }); }
    if (!result.blocked) {
      result = { ...result, servers: await resolver.orderServers(result.servers || [], { maxProbe: 3, probeMs: 7000 }) };
      cacheSet(cacheKey, result);
    }
  }

  if (result.blocked) {
    const msg = result.reason === 'login_required' ? 'يتطلب تسجيل الدخول' : 'يتطلب عضوية VIP';
    return sendJson(res, 200, { streams: [{ name: 'Stardima', title: msg, externalUrl: stardima.BASE + '/membership' }] });
  }

  // One Stremio stream per server. The url points at our /proxy/embed endpoint,
  // which resolves the actual m3u8/mp4 FRESH when the player requests it.
  const streams = (result.servers || []).map((srv) => ({
    name: `Stardima · ${srv.name}`,
    title: `${srv.name}${srv.is_vip ? ' (VIP)' : ''}`,
    url: `${PROXY_BASE}/proxy/embed?u=${b64url(srv.embedUrl)}&n=${b64url(srv.name)}`,
    behaviorHints: { notWebReady: true },
  }));
  sendJson(res, 200, { streams });
}

// ---------- diagnostics: show what THIS host sees (direct vs worker relay) ----------
async function handleDebug(req, res) {
  const W = 'https://stardima-proxy.ingots-18joist.workers.dev';
  const out = { host: 'render-or-local', ts: new Date().toISOString() };
  try { const r = await fetch(stardima.BASE + '/', { headers: { 'User-Agent': 'Mozilla/5.0' } }); out.direct_root = r.status; }
  catch (e) { out.direct_root = 'ERR ' + e.message; }
  try { const r = await fetch(W + '/', {}); out.worker_root = r.status; }
  catch (e) { out.worker_root = 'ERR ' + e.message; }
  try { const r = await fetch(W + '/search?query=naruto', { headers: { 'X-Requested-With': 'XMLHttpRequest', 'Accept': 'application/json' } }); out.worker_search = r.status; }
  catch (e) { out.worker_search = 'ERR ' + e.message; }
  sendJson(res, 200, out);
}

// ---------- proxy: resolve a host EMBED fresh at playback time ----------
// The upstream m3u8 token is short-lived, so we resolve it the moment the
// player asks, then immediately fetch + rewrite the master playlist.
async function handleProxyEmbed(req, res, query) {
  const embedUrl = unb64url(query.u || '');
  if (!embedUrl) return sendText(res, 400, 'missing embed');
  PROXY_BASE = addonBase(req);
  // The upstream CDN load-balances across many edges; some intermittently 403.
  // Re-resolving the embed yields a fresh token/edge, so retry a few times.
  const MAX_TRIES = 4;
  let lastStatus = 0;
  for (let attempt = 0; attempt < MAX_TRIES; attempt++) {
    try {
      const r = await resolveHost(embedUrl); // fetch embed, unpack, extract m3u8/mp4 (fresh)
      if (!r || !r.url) { lastStatus = 404; continue; }
      if (r.type === 'hls') {
        const upstream = await fetchT(r.url, { headers: { 'User-Agent': UA, Referer: r.referer, Accept: '*/*' } }, 12000);
        lastStatus = upstream.status;
        if (!upstream.ok) continue; // try a fresh edge
        const text = await upstream.text();
        const rewritten = rewriteM3u8(text, r.url, r.referer);
        res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
        return res.end(rewritten);
      }
      // mp4: stream bytes through (fresh fetch with referer)
      return pipeUpstream(req, res, r.url, r.referer);
    } catch (e) {
      lastStatus = 502;
    }
  }
  return sendText(res, lastStatus || 502, 'could not resolve a working stream edge (last status ' + lastStatus + ')');
}

// ---------- proxy: fetch an absolute url (variant playlist / segment / mp4) ----------
async function handleProxy(req, res, query) {
  const target = unb64url(query.u || '');
  const referer = query.r ? unb64url(query.r) : undefined;
  if (!target) return sendText(res, 400, 'missing target');
  try {
    const upstream = await fetchT(target, {
      headers: { 'User-Agent': UA, ...(referer ? { Referer: referer } : {}), 'Accept': '*/*' },
      redirect: 'follow',
    }, 15000);
    if (!upstream.ok) return sendText(res, upstream.status, 'upstream ' + upstream.status);
    const ctype = upstream.headers.get('content-type') || '';
    const isPlaylist = /\.m3u8(\?|$)/i.test(target) || /mpegurl/i.test(ctype);
    if (isPlaylist) {
      const text = await upstream.text();
      PROXY_BASE = addonBase(req);
      const rewritten = rewriteM3u8(text, target, referer);
      res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
      return res.end(rewritten);
    }
    // segment / mp4 bytes
    res.writeHead(200, {
      'Content-Type': ctype || 'application/octet-stream',
      'Access-Control-Allow-Origin': '*',
      'Accept-Ranges': 'bytes',
      'Cache-Control': /video|mpegurl/i.test(ctype) ? 'max-age=3600' : 'no-store',
    });
    const buf = Buffer.from(await upstream.arrayBuffer());
    return res.end(buf);
  } catch (e) {
    return sendText(res, 502, 'proxy error: ' + e.message);
  }
}

// Stream an upstream file (mp4) through to the client, preserving range requests.
async function pipeUpstream(req, res, url, referer) {
  const headers = { 'User-Agent': UA, ...(referer ? { Referer: referer } : {}) };
  if (req.headers.range) headers.Range = req.headers.range;
  const upstream = await fetchT(url, { headers, redirect: 'follow' }, 30000);
  if (!upstream.ok && upstream.status !== 206) return sendText(res, upstream.status, 'upstream ' + upstream.status);
  const h = {};
  for (const k of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
    const v = upstream.headers.get(k); if (v) h[k] = v;
  }
  res.writeHead(upstream.status, { ...h, 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'max-age=3600' });
  const buf = Buffer.from(await upstream.arrayBuffer());
  res.end(buf);
}

// ---------- router ----------
const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://localhost');
    const path = u.pathname.replace(/\.json$/, '');
    const query = Object.fromEntries(u.searchParams.entries());

    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET,OPTIONS' });
      return res.end();
    }

    if (path === '/' || path === '/index.html') {
      return sendText(res, 200, installPage(req), 'text/html; charset=utf-8');
    }
    if (path === '/manifest.json' || path === '/manifest') {
      return sendJson(res, 200, await buildManifest());
    }
    if (path === '/debug') {
      return handleDebug(req, res);
    }
    if (path === '/proxy/embed') {
      return handleProxyEmbed(req, res, query);
    }
    if (path === '/proxy') {
      return handleProxy(req, res, query);
    }
    let m;
    if ((m = path.match(/^\/catalog\/([^/]+)\/([^/]+)(?:\/([^/]+))?$/))) {
      // Stremio/Nuvio pass extras in the PATH: /catalog/type/id/search=X&skip=Y.json
      for (const kv of (m[3] || '').split('&')) {
        const i = kv.indexOf('=');
        if (i > 0) query[kv.slice(0, i)] = decodeURIComponent(kv.slice(i + 1));
      }
      return handleCatalog(req, res, m[1], m[2], query);
    }
    if ((m = path.match(/^\/meta\/([^/]+)\/([^/]+)$/))) {
      return handleMeta(req, res, m[1], decodeURIComponent(m[2]));
    }
    if ((m = path.match(/^\/stream\/([^/]+)\/([^/]+)$/))) {
      return handleStream(req, res, m[1], decodeURIComponent(m[2]));
    }
    return sendJson(res, 404, { error: 'not found', path });
  } catch (e) {
    return sendJson(res, 500, { error: e.message });
  }
});

function installPage(req) {
  const base = addonBase(req);
  return `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Stardima Addon</title>
<style>
body{font-family:system-ui,'Segoe UI',Tahoma,sans-serif;background:#0f1115;color:#e7e9ee;margin:0;padding:32px;line-height:1.7}
.card{max-width:720px;margin:0 auto;background:#171a21;border:1px solid #262b36;border-radius:16px;padding:28px}
h1{font-size:24px;margin:0 0 4px} .sub{color:#9aa3b2;margin:0 0 20px}
code{background:#0b0d12;border:1px solid #262b36;border-radius:8px;padding:10px 12px;display:block;word-break:break-all;direction:ltr;text-align:left;color:#7fd1ff;font-size:13px}
.btn{display:inline-block;margin-top:14px;background:#2563eb;color:#fff;text-decoration:none;padding:10px 18px;border-radius:10px;font-weight:600}
ul{padding-inline-start:20px} li{margin:6px 0}
.tag{display:inline-block;background:#1f2937;color:#9aa3b2;border-radius:999px;padding:2px 10px;font-size:12px;margin-inline-end:6px}
</style></head><body><div class="card">
<h1>🎬 Stardima Addon</h1>
<p class="sub">أدئون ستارديما لـ Stremio / Nuvio — كتالوج + بث</p>
<p>رابط التثبيت (manifest):</p>
<code id="mf">${base}/manifest.json</code>
<a class="btn" href="${base}/manifest.json">افتح الـ manifest</a>
<p style="margin-top:22px"><b>طريقة التثبيت:</b></p>
<ul>
<li><b>Stremio:</b> افتح الرابط في المتصفح → يظهر زر Install، أو الصق الرابط في Web addon.</li>
<li><b>Nuvio:</b> Settings → Content & Discovery → Addons → الصق رابط الـ manifest.</li>
</ul>
<p style="margin-top:18px"><span class="tag">series</span><span class="tag">movie</span><span class="tag">search</span><span class="tag">HLS proxy</span></p>
<p style="color:#6b7280;font-size:12px;margin-top:20px">ملاحظة: بعض الحلقات محمية بـ VIP/تسجيل دخول على ستارديما، وهذي ما بيرجع لها بث.</p>
</div></body></html>`;
}

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Stardima addon listening on 0.0.0.0:${PORT}`);
  console.log(`Manifest: http://0.0.0.0:${PORT}/manifest.json`);
});
