/* Stardima Add-on — Cloudflare Worker bundle (self-contained, no deps)
 * Catalogs are served from an embedded, alphabetically-sorted index (built by
 * build-index.js) merged with a live fetch of the newest listing pages, so new
 * releases appear in their correct alphabetical position within ~15 minutes. */
const {
  BASE, getJson, videoToItem, getSeriesMeta, getMovieMeta, getEpisodeLink,
  searchCatalog, compactPoster, decodePoster, byTitleAr, normTitle,
} = require('./lib/stardima');
const { getServers, getMovieServers, orderServers } = require('./lib/resolver');
const { resolveHost, UA } = require('./lib/hosts');

const NAME = 'Stardima';
const VERSION = '3.0.0';
const ID = 'community.stardima';
const CHUNK_SIZE = 450; // items per chunked catalog
// 'single'  = two long catalogs (all series, all movies) — one list, nothing to navigate
// 'chunked' = 450-item shelves (stardima-s1..s6, stardima-m1..m4)
// A specific install can pin a mode: {url}/manifest.json?mode=chunked
const CATALOG_MODE_DEFAULT = 'single';
function catalogMode(url) {
  const v = (url && url.searchParams && url.searchParams.get('mode')) || '';
  if (v === 'chunked' || v === 'single') return v;
  return CATALOG_MODE_DEFAULT;
}

// Replaced at build time by build-worker.js with catalog-index.min.json
const INDEX = /*__INDEX__*/{};

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// ---- helpers --------------------------------------------------------------
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=300', ...CORS_HEADERS },
  });
}
function notFound() { return json({ metas: [], meta: null, streams: [] }, 404); }
function slugFromUrl(url) {
  if (!url) return '';
  const p = String(url).split('/').filter(Boolean);
  return p[p.length - 1] || '';
}
function keyOf(id) { return /^stardima-m/.test(id || '') ? 'movies' : 'series'; }
function epOfKey(key) { return key === 'movies' ? 'aflam' : 'mosalsalat'; }
function chunkOf(id) { const m = /(\d+)$/.exec(id || ''); return m ? parseInt(m[1], 10) : 1; }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Worker-safe base64url (no Buffer in Workers)
function b64url(str) {
  const bytes = new TextEncoder().encode(str || '');
  let bin = ''; for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function unb64url(str) {
  const b = String(str || '').replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b + '='.repeat((4 - (b.length % 4)) % 4));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}
async function fetchT(target, opts, ms) {
  try { return await fetch(target, { ...opts, signal: AbortSignal.timeout(ms || 15000) }); }
  catch (e) { throw e; }
}
function proxiedRaw(origin, targetUrl, referer) {
  return `${origin}/proxy?u=${b64url(targetUrl)}&r=${b64url(referer || '')}`;
}
// Rewrite an m3u8 playlist so every URI routes back through this Worker.
function rewriteM3u8(playlistText, playlistUrl, referer, origin) {
  const lines = String(playlistText).split(/\r?\n/);
  const out = [];
  for (let line of lines) {
    const trimmed = line.trim();
    if (!trimmed) { out.push(line); continue; }
    if (trimmed.startsWith('#')) {
      out.push(line.replace(/URI="([^"]+)"/g, (m, uri) => `URI="${proxiedRaw(origin, new URL(uri, playlistUrl).href, referer)}"`));
      continue;
    }
    out.push(proxiedRaw(origin, new URL(trimmed, playlistUrl).href, referer));
  }
  return out.join('\n');
}
function playlistResponse(text) {
  return new Response(text, { headers: { 'Content-Type': 'application/vnd.apple.mpegurl', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store', ...CORS_HEADERS } });
}
function textResponse(t, status) {
  return new Response(t, { status: status || 200, headers: { 'Content-Type': 'text/plain; charset=utf-8', ...CORS_HEADERS } });
}
function passthrough(up, req) {
  const h = new Headers();
  ['content-type', 'content-length', 'accept-ranges', 'content-range'].forEach((k) => { const v = up.headers.get(k); if (v) h.set(k, v); });
  h.set('Access-Control-Allow-Origin', '*');
  h.set('Cache-Control', 'no-store');
  return new Response(up.body, { status: up.status, headers: h });
}
// episodeId from a Stremio id: 'series:<slug>:<epId>' | '<slug>:<epId>' | '<slug>'
async function episodeIdFor(type, id) {
  const parts = String(id || '').split(':');
  if (parts.length >= 2 && /^\d+$/.test(parts[parts.length - 1])) return parts[parts.length - 1];
  const slug = parts[parts.length - 1];
  if (!slug) return null;
  try {
    if (type === 'movie') {
      const m = await getMovieMeta(slug);
      return (m && m.movieEpisodeId) || null;
    }
    const m = await getSeriesMeta(slug);
    const v = (m && m.videos) || [];
    if (!v.length) return null;
    return v[0].episodeId || String(v[0].id).split(':').pop();
  } catch (e) { return null; }
}


// ---- genres (site categories, embedded at build time) --------------------
function genreLabels() { return (((INDEX.genres || {}).labels) || []); }
function genreOptions() { return genreLabels().map(([, label]) => label); }
function genreSlugsOf(slug) {
  const raw = (((INDEX.genres || {}).items) || {})[slug];
  if (!raw) return [];
  return String(raw).split(',').map((n) => (genreLabels()[parseInt(n, 10)] || [])[1]).filter(Boolean);
}
function genreMatches(slug, wanted) {
  const w = String(wanted || '').trim();
  if (!w) return true;
  const nw = normTitle(w); // 'أنمي' must match the site's 'انمي'
  const labels = genreLabels();
  let gi = labels.findIndex(([sl, lb]) => lb === w || sl === w || normTitle(lb) === nw);
  if (gi < 0) gi = labels.findIndex(([sl, lb]) => normTitle(lb).indexOf(nw) >= 0); // 'أفلام دورايمون' ⊂ 'أفلام دورايمون - Doraemon Movie'
  if (gi < 0) return false;
  const raw = (((INDEX.genres || {}).items) || {})[slug];
  if (!raw) return false;
  return (',' + raw + ',').indexOf(',' + gi + ',') >= 0;
}

// ---- alphabetical catalog (embedded index + live newest pages) ------------
const _cache = new Map();
const FRESH_TTL = 15 * 60 * 1000; // 15 min

async function fetchNewest(ep) {
  const hit = _cache.get('fresh:' + ep);
  if (hit && Date.now() - hit.t < FRESH_TTL) return hit.v;
  const out = [];
  for (const p of [1, 2, 3]) {
    try {
      const j = await getJson(`${BASE}/${ep}?page=${p}`);
      (j.videos || []).forEach(v => {
        const slug = slugFromUrl(v.url);
        if (slug) out.push([slug, (v.title || '').trim(), compactPoster(v.poster_url || v.poster), String(v.year || '')]);
      });
    } catch (e) { /* keep whatever we got */ }
    await sleep(80);
  }
  if (out.length) _cache.set('fresh:' + ep, { t: Date.now(), v: out });
  return out.length ? out : (hit ? hit.v : []);
}

// ---- search: live site results + instant match on the embedded index -----
let _rows = null;
function indexRows() {
  if (_rows) return _rows;
  _rows = [];
  for (const key of ['series', 'movies']) {
    const type = key === 'movies' ? 'movie' : 'series';
    for (const it of ((INDEX[key] || {}).items) || []) {
      _rows.push({ type, slug: it[0], title: it[1], poster: it[2], year: it[3], n: normTitle(it[1]) });
    }
  }
  return _rows;
}
function searchIndex(q) {
  const nq = normTitle(q);
  if (nq.length < 2) return [];
  const out = [];
  for (const r of indexRows()) {
    const i = r.n.indexOf(nq);
    if (i < 0) continue;
    out.push({ id: r.type + ':' + r.slug, type: r.type, slug: r.slug, title: r.title,
      poster: decodePoster(r.poster) || undefined, year: r.year || undefined });
  }
  return out;
}
// Site results win when both know a title; the index adds everything the site
// search misses (odd spellings, long-tail titles, or the site being down).
function mergeSearch(site, q) {
  const out = new Map();
  for (const x of site || []) {
    const type = x.type || 'series';
    out.set(type + ':' + (x.slug || x.id), { ...x, type });
  }
  for (const x of searchIndex(q)) if (!out.has(x.id)) out.set(x.id, x);
  const nq = normTitle(q);
  const arr = [...out.values()];
  for (const x of arr) x.q = normTitle(x.title).startsWith(nq) ? 0 : 1; // prefix hits first
  arr.sort((a, b) => a.q - b.q || byTitleAr(a.title, b.title));
  return arr.slice(0, 150);
}

async function newestShelf(key) {
  const items = await fetchNewest(epOfKey(key));
  const seen = new Set(); const out = [];
  for (const it of items) { if (seen.has(it[0])) continue; seen.add(it[0]); out.push(it); }
  return out;
}

async function sortedItems(key) {
  const ck = 'sorted:' + key;
  const hit = _cache.get(ck);
  if (hit && Date.now() - hit.t < FRESH_TTL) return hit.v;
  const base = ((INDEX[key] || {}).items) || [];
  const map = new Map();
  for (const it of base) map.set(it[0], it);
  for (const it of await fetchNewest(epOfKey(key))) map.set(it[0], it); // newest wins
  const arr = [...map.values()].sort((a, b) => byTitleAr(a[1], b[1]));
  _cache.set(ck, { t: Date.now(), v: arr });
  return arr;
}

function chunkCount(key) {
  const n = (((INDEX[key] || {}).items) || []).length;
  return Math.max(1, Math.ceil(n / CHUNK_SIZE));
}

// ---- manifest -------------------------------------------------------------
function buildManifest(url) {
  const mode = catalogMode(url);
  const arabicNum = (n) => String(n).replace(/\d/g, d => '٠١٢٣٤٥٦٧٨٩'[d]);
  const searchExtra = [{ name: 'search', isRequired: false }];
  const series = [], movies = [];
  if (mode === 'single') {
    const genreExtra = genreOptions().length
      ? [{ name: 'genre', options: genreOptions(), isRequired: false }] : [];
    series.push({ id: 'stardima-new', type: 'series', name: `${NAME}: أحدث المسلسلات`, extra: searchExtra });
    series.push({ id: 'stardima', type: 'series', name: `${NAME}: مسلسلات (أ-ي)`, extra: [...genreExtra, ...searchExtra] });
    movies.push({ id: 'stardima-new-movies', type: 'movie', name: `${NAME}: أحدث الأفلام`, extra: searchExtra });
    movies.push({ id: 'stardima-movies', type: 'movie', name: `${NAME}: أفلام (أ-ي)`, extra: [...genreExtra, ...searchExtra] });
  } else {
    const sChunks = chunkCount('series'), mChunks = chunkCount('movies');
    for (let c = 1; c <= sChunks; c++) series.push({
      id: 'stardima-s' + c, type: 'series',
      name: c === 1 ? `${NAME}: مسلسلات` : `${NAME}: مسلسلات (${arabicNum(c)})`,
      extra: searchExtra,
    });
    for (let c = 1; c <= mChunks; c++) movies.push({
      id: 'stardima-m' + c, type: 'movie',
      name: c === 1 ? `${NAME}: أفلام` : `${NAME}: أفلام (${arabicNum(c)})`,
      extra: searchExtra,
    });
  }
  const sN = (((INDEX.series || {}).items) || []).length;
  const mN = (((INDEX.movies || {}).items) || []).length;
  return {
    id: ID, version: VERSION, name: `${NAME} — ستارديما (أ-ي)`,
    description: 'مكتبة ستارديما كاملة مرتبة أبجديًا: ' + sN + ' مسلسل و' + mN + ' فيلم، مع حلقات وبث مباشر',
    resources: ['catalog', 'meta', 'stream'], types: ['series', 'movie'],
    idPrefixes: ['stardima:'], catalogs: [...series, ...movies],
    behaviorHints: { configurableFor: false, configurationRequired: false },
  };
}

// ---- routes ---------------------------------------------------------------
let _ctx = null; // execution context, so probes can outlive the response
async function handleRequest(url, req, ctx) {
  _ctx = ctx || _ctx;
  let path = url.pathname;
  if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
  if (path.endsWith('.json')) path = path.slice(0, -5);

  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (path === '/manifest.json' || path === '/manifest') return json(buildManifest(url));
  if (path === '/' || path === '/configure') {
    return new Response(`<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${NAME} — ستارديما (أ-ي)</title>
<style>body{font-family:system-ui,-apple-system,sans-serif;background:#0b1020;color:#e8ecf5;margin:0;padding:22px;line-height:1.7}
.card{max-width:640px;margin:0 auto;background:#141b33;border:1px solid #24305a;border-radius:16px;padding:22px}
input{width:100%;padding:12px;border-radius:10px;border:1px solid #2c3a6b;background:#0d1428;color:#e8ecf5;box-sizing:border-box;direction:ltr;font-size:13px}
button,.btn{display:inline-block;margin:12px 6px 0 0;padding:12px 18px;background:#3b82f6;color:#fff;border:0;border-radius:10px;text-decoration:none;font-size:15px;cursor:pointer}
.btn.s2{background:#1f2a4d;border:1px solid #34406e}
.ok{color:#4ade80;margin-inline-start:10px;font-size:14px}
ol,ul{padding-inline-start:20px;opacity:.92}
hr{border:0;border-top:1px solid #24305a;margin:20px 0}
small{opacity:.6}</style></head><body><div class="card">
<h1 style="margin:0 0 6px;font-size:21px">🎬 ستارديما — مرتب أ-ي</h1>
<p style="opacity:.8;margin:0 0 16px">2257 مسلسل · 1597 فيلم · حلقات · بحث · بث مباشر</p>
<p style="margin:0 0 6px">رابط الأدئون (الصقه في Nuvio أو Stremio):</p>
<input id="u" readonly value="${url.origin}/manifest.json" onclick="this.select()">
<div><button onclick="cp()">📋 نسخ الرابط</button><span id="m" class="ok"></span>
<a class="btn s2" href="stremio://${url.host}/manifest.json">▶ Stremio</a></div>
<hr>
<p style="margin:0;font-weight:600">Nuvio (آيباد/جوال):</p>
<ol><li>الإعدادات ← الأدئونات / Add-ons</li><li>«إضافة أدئون» ثم لصق الرابط</li><li>ارجع للمكتبة ← مسلسلات / أفلام</li></ol>
<p style="margin:0;font-weight:600">Stremio:</p>
<ol><li>Addons ← Install from URL ← الصق الرابط</li></ol>
<hr><small>يعمل مباشرة بدون حساب. الحلقات تُحل عند الضغط على «تشغيل».</small>
<script>function cp(){var i=document.getElementById('u');i.select();i.setSelectionRange(0,999);
try{navigator.clipboard.writeText(i.value);}catch(e){document.execCommand('copy');}
document.getElementById('m').textContent='تم النسخ ✓';setTimeout(function(){document.getElementById('m').textContent='';},2000);}</script>
</div></body></html>`, { headers: { 'Content-Type': 'text/html; charset=utf-8', ...CORS_HEADERS } });
  }

  if (path === '/health') {
    const hk = 'health:site';
    let site = _cache.get(hk);
    if (!site || Date.now() - site.t > 5 * 60 * 1000) {
      let v;
      try { const j = await getJson(BASE + '/mosalsalat?page=1'); v = { ok: true, rows: ((j.videos) || []).length }; }
      catch (e) { v = { ok: false, error: String((e && e.message) || e).slice(0, 120) }; }
      site = { t: Date.now(), v }; _cache.set(hk, site);
    }
    const keys = [..._cache.keys()];
    return json({
      ok: !!site.v.ok, version: VERSION, mode: catalogMode(url), site: site.v,
      index: { built: INDEX.built || null, series: (((INDEX.series || {}).items) || []).length, movies: (((INDEX.movies || {}).items) || []).length },
      caches: {
        total: keys.length,
        meta: keys.filter(k => k.startsWith('meta:')).length,
        servers: keys.filter(k => k.startsWith('servers:') || k.startsWith('movieServers:')).length,
        search: keys.filter(k => k.startsWith('search:')).length,
      },
      now: new Date().toISOString(),
    });
  }

  // /catalog/{type}/{id}[/extras].json — Stremio puts extras in the path segment
  if (path.startsWith('/catalog/')) {
    const m = /^\/catalog\/([^/]+)\/([^/]+)(?:\/([^/]+))?$/.exec(path);
    if (!m) return notFound();
    const type = m[1], id = m[2];
    const extras = {};
    for (const src of [m[3], url.search.slice(1)]) {
      if (!src) continue;
      for (const kv of src.split('&')) {
        if (!kv) continue;
        const i = kv.indexOf('=');
        if (i < 0) continue;
        try { extras[decodeURIComponent(kv.slice(0, i))] = decodeURIComponent(kv.slice(i + 1).replace(/\+/g, ' ')); } catch (e) { /* skip */ }
      }
    }
    if (type !== 'series' && type !== 'movie') return notFound();

    if (extras.search) {
      const q = extras.search.trim();
      const sc = 'search:' + q;
      let hitS = _cache.get(sc);
      if (!hitS || Date.now() - hitS.t > 10 * 60 * 1000) {
        let site = [];
        try { site = await searchCatalog(q); } catch (e) { site = []; } // site down? the embedded index still answers
        hitS = { t: Date.now(), v: mergeSearch(site, q) };
        _cache.set(sc, hitS); // shared across catalog types and users
      }
      const metas = hitS.v.filter(x => x.type === type).map(x => ({
        id: 'stardima:' + (x.slug || x.id), type, name: x.title,
        poster: x.poster || undefined, releaseInfo: x.year ? String(x.year) : undefined,
      }));
      return json({ metas });
    }

    const key = type === 'series' ? 'series' : 'movies'; // the type segment is authoritative
    const toMeta = (it) => ({
      id: 'stardima:' + it[0], type, name: it[1],
      poster: decodePoster(it[2]) || undefined,
      releaseInfo: it[3] || undefined,
    });
    if (id === 'stardima-new' || id === 'stardima-new-movies') {
      return json({ metas: (await newestShelf(key)).map(toMeta) }); // site order = newest first
    }
    let sorted = await sortedItems(key);
    if (extras.genre) sorted = sorted.filter((it) => genreMatches(it[0], extras.genre));
    if (extras.skip) { const sk = parseInt(extras.skip, 10) || 0; if (sk > 0) sorted = sorted.slice(sk); }
    const total = sorted.length;
    // Older installs (and ?mode=chunked) still ask for stardima-s3 / stardima-m2
    // style ids — keep serving those as 450-item slices so nothing breaks.
    const isChunkId = /^stardima-[sm]\d+$/.test(id);
    if (!isChunkId && catalogMode(url) === 'single') {
      // One long list per type: Nuvio loads it once and scrolls locally.
      return json({ metas: sorted.map(toMeta) });
    }
    const chunks = Math.max(1, Math.ceil(total / CHUNK_SIZE));
    const c = Math.min(Math.max(1, chunkOf(id)), chunks);
    const start = (c - 1) * CHUNK_SIZE;
    const end = c === chunks ? total : Math.min(start + CHUNK_SIZE, total); // last chunk uncapped
    return json({ metas: sorted.slice(start, end).map(toMeta) });
  }

  // /meta/{type}/{id}.json  (id = stardima:{slug})
  if (path.startsWith('/meta/')) {
    const m = /^\/meta\/([^/]+)\/([^/]+)$/.exec(path);
    if (!m) return notFound();
    const type = m[1];
    const slug = decodeURIComponent(m[2]).replace(/^stardima:/, '').split(':')[0];
    const ck = 'meta:' + type + ':' + slug;
    const hit = _cache.get(ck);
    if (hit && Date.now() - hit.t < 30 * 60 * 1000) return json(hit.v);
    const meta = type === 'series' ? await getSeriesMeta(slug) : type === 'movie' ? await getMovieMeta(slug) : null;
    if (!meta) return notFound();
    meta.id = 'stardima:' + slug;
    const gs = genreSlugsOf(slug); if (gs.length) meta.genres = gs;
    let out;
    if (type === 'movie') {
      out = { meta: { ...meta, videos: undefined } };
    } else {
      meta.videos = (meta.videos || []).map((v) => ({
        ...v,
        id: 'stardima:' + slug + ':' + (v.episodeId || String(v.id || '').split(':').pop()),
      }));
      out = { meta };
    }
    _cache.set(ck, { t: Date.now(), v: out });
    return json(out);
  }

  // /stream/{type}/{id}.json — servers health-ordered, resolved lazily at playback
  if (path.startsWith('/stream/')) {
    const m = /^\/stream\/([^/]+)\/([^/]+)$/.exec(path);
    if (!m) return notFound();
    const type = m[1];
    const raw = decodeURIComponent(m[2]).replace(/^stardima:/, '');
    if (type !== 'series' && type !== 'movie') return notFound();
    const parts = raw.split(':');
    const epId = parts.length >= 2 && /^\d+$/.test(parts[parts.length - 1]) ? parts[parts.length - 1] : null;
    const slug = parts[parts.length - 1];
    if (!epId && !slug) return json({ streams: [] });

    // Series with no episode chosen: fall back to the first one.
    let useEpId = epId;
    if (!useEpId && type === 'series') {
      try {
        const mm = await getSeriesMeta(slug);
        const v = (mm && mm.videos) || [];
        if (v.length) useEpId = v[0].episodeId || String(v[0].id).split(':').pop();
      } catch (e) { /* none */ }
    }
    if (type === 'series' && !useEpId) return json({ streams: [] });

    const ck = (useEpId ? 'servers:' + useEpId : 'movieServers:' + slug);
    let ordered = null;
    const hit = _cache.get(ck);
    if (hit && Date.now() - hit.t < 10 * 60 * 1000) ordered = hit.v;
    if (!ordered) {
      let result;
      try { result = useEpId ? await getServers(useEpId) : await getMovieServers(slug); }
      catch (e) { return json({ streams: [] }); }
      if (!result) return json({ streams: [] });
      if (result.blocked) {
        const msg = result.reason === 'login_required' ? 'يتطلب تسجيل الدخول' : 'يتطلب عضوية VIP';
        return json({ streams: [{ name: NAME, title: msg, externalUrl: BASE + '/membership' }] });
      }
      // Working server first: rank by host reachability, then health-probe.
      ordered = await orderServers(result.servers || [], {
        maxProbe: 3,
        waitUntil: (p) => { try { _ctx && _ctx.waitUntil(p); } catch (e) { /* no ctx */ } },
      });
      if (ordered.length) _cache.set(ck, { t: Date.now(), v: ordered });
    }
    const origin = url.origin;
    return json({
      streams: (ordered || []).map((srv) => ({
        name: `${NAME} · ${srv.name}`,
        title: `${srv.name}${srv.is_vip ? ' (VIP)' : ''}`,
        url: `${origin}/proxy/embed?u=${b64url(srv.embedUrl)}&n=${b64url(srv.name || '')}`,
        behaviorHints: { notWebReady: true, bingeGroup: srv.name },
      })),
    });
  }

  // /proxy/embed?u=<b64url embed> — resolve the host embed FRESH at playback time
  if (path === '/proxy/embed') {
    const embedUrl = unb64url(url.searchParams.get('u') || '');
    if (!embedUrl) return textResponse('missing embed', 400);
    const origin = url.origin;
    let lastStatus = 0;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const r = await resolveHost(embedUrl);
        if (!r || !r.url) { lastStatus = 404; continue; }
        if (r.type === 'hls') {
          const up = await fetchT(r.url, { headers: { 'User-Agent': UA, Referer: r.referer, Accept: '*/*' } }, 12000);
          lastStatus = up.status;
          if (!up.ok) continue; // try a fresh CDN edge
          return playlistResponse(rewriteM3u8(await up.text(), r.url, r.referer, origin));
        }
        const hdrs = { 'User-Agent': UA, Referer: r.referer, Accept: '*/*' };
        const range = req.headers.get('range'); if (range) hdrs.Range = range;
        const up = await fetchT(r.url, { headers: hdrs }, 20000);
        lastStatus = up.status;
        if (!up.ok) continue;
        return passthrough(up, req);
      } catch (e) { lastStatus = 502; }
    }
    return textResponse('could not resolve a working stream edge (last status ' + lastStatus + ')', lastStatus || 502);
  }

  // /proxy?u=<b64url>&r=<b64url>  (also accepts legacy /proxy/<encoded absolute url>)
  if (path === '/proxy' || path.startsWith('/proxy/')) {
    let target = url.searchParams.get('u');
    const refParam = url.searchParams.get('r');
    target = target ? unb64url(target) : decodeURIComponent(path.slice(7));
    const referer = refParam ? unb64url(refParam) : undefined;
    if (!/^https?:\/\//i.test(target || '')) return textResponse('bad target', 400);
    try {
      const hdrs = { 'User-Agent': UA, Accept: '*/*' };
      if (referer) hdrs.Referer = referer;
      const range = req.headers.get('range'); if (range) hdrs.Range = range;
      const up = await fetchT(target, { headers: hdrs, redirect: 'follow' }, 15000);
      if (!up.ok) return textResponse('upstream ' + up.status, up.status);
      const ctype = up.headers.get('content-type') || '';
      if (/\.m3u8(\?|$)/i.test(target) || /mpegurl/i.test(ctype)) {
        return playlistResponse(rewriteM3u8(await up.text(), target, referer, url.origin));
      }
      return passthrough(up, req);
    } catch (e) {
      return textResponse('proxy error: ' + e.message, 502);
    }
  }

  if (path.startsWith('/resolve/')) {
    try {
      const target = decodeURIComponent(path.slice(9));
      if (!/^https?:\/\//.test(target)) return new Response('bad', { status: 400, headers: CORS_HEADERS });
      const out = await resolveHost(target);
      return json({ url: target, ...out });
    } catch (e) {
      return json({ error: e.message }, 500);
    }
  }

  return json({ name: NAME, status: 'ok', manifest: url.origin + '/manifest.json', version: VERSION });
}

module.exports = {
  async fetch(req, env, ctx) {
    try {
      return await handleRequest(new URL(req.url), req, ctx);
    } catch (e) {
      return json({ error: e.message }, 500);
    }
  },
};
