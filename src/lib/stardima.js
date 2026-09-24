// Stardima site client: catalog scraping, show meta, seasons, episodes,
// and episode stream-link lookup. All endpoints reverse-engineered from the
// site's own frontend (Laravel + Inertia).

const BASE = process.env.STARDIMA_BASE || 'https://stardima-s7.cartoon.com.im';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

// Full browser-like header sets. Cloudflare/front-ends often 403 requests from
// datacenter IPs (Render etc.) that look like bots; a complete, realistic header
// set is the first line of defence.
function htmlHeaders(referer) {
  return {
    'User-Agent': UA,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9,ar;q=0.8',
    'Cache-Control': 'no-cache',
    'Pragma': 'no-cache',
    'Sec-Ch-Ua': '"Not/A)Brand";v="8", "Chromium";v="126", "Google Chrome";v="126"',
    'Sec-Ch-Ua-Mobile': '?0',
    'Sec-Ch-Ua-Platform': '"Windows"',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': referer ? 'same-origin' : 'none',
    'Sec-Fetch-User': '?1',
    'Upgrade-Insecure-Requests': '1',
    ...(referer ? { 'Referer': referer } : { 'Referer': BASE + '/' }),
  };
}
function ajaxHeaders(referer) {
  return {
    'User-Agent': UA,
    'Accept': 'application/json, text/javascript, */*; q=0.01',
    'Accept-Language': 'en-US,en;q=0.9,ar;q=0.8',
    'X-Requested-With': 'XMLHttpRequest',
    'Sec-Ch-Ua': '"Not/A)Brand";v="8", "Chromium";v="126", "Google Chrome";v="126"',
    'Sec-Ch-Ua-Mobile': '?0',
    'Sec-Ch-Ua-Platform': '"Windows"',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'same-origin',
    'Referer': referer || BASE + '/',
  };
}

// If a cloud host's IP is blocked by Stardima/Cloudflare (403), automatically
// fall back to the user's Cloudflare Worker relay (clean CF edge IP). This makes
// the addon work on Render etc. with NO environment configuration.
const WORKER_FALLBACK = (process.env.STARDIMA_RELAY || 'https://stardima-proxy.ingots-18joist.workers.dev').replace(/\/+$/, '');

async function smartFetch(path, headers) {
  // Accept both relative paths and absolute URLs — callers pass `${BASE}/...`
  // in a few places, and blindly prepending BASE produced a doubled URL that
  // failed silently (new-arrivals merge, health check).
  const target = /^https?:\/\//i.test(path) ? path : BASE + path;
  const rel = target.startsWith(BASE) ? target.slice(BASE.length) : path;
  let res;
  try { res = await fetch(target, { headers }); }
  catch (e) { res = null; }
  if (res && res.ok) return res;
  const blocked = !res || res.status === 403 || res.status === 429 || res.status === 503;
  if (blocked && WORKER_FALLBACK) {
    try {
      const r2 = await fetch(WORKER_FALLBACK + rel, { headers });
      if (r2.ok) return r2;
    } catch (e) { /* fall through to original error */ }
  }
  if (!res) throw new Error('network error for ' + target);
  return res;
}

async function getJson(path, referer) {
  const res = await smartFetch(path, ajaxHeaders(referer));
  if (!res.ok) throw new Error('HTTP ' + res.status + ' for ' + path);
  return res.json();
}
async function getHtml(path, referer) {
  const res = await smartFetch(path, htmlHeaders(referer));
  if (!res.ok) throw new Error('HTTP ' + res.status + ' for ' + path);
  return res.text();
}

function decodeEntities(s) {
  return (s || '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#039;|&apos;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/\\u([\da-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .trim();
}
function metaContent(html, prop) {
  const re = new RegExp('<meta[^>]+(?:property|name)="' + prop + '"[^>]+content="([^"]*)"', 'i');
  const m = html.match(re);
  return m ? decodeEntities(m[1]) : null;
}

// ---- CATALOG ----
// The public site spreads its library across a few listing pages (homepage plus
// category pages). We union them all so the addon shows the maximum public set.
const CATALOG_PAGES = ['/', '/mosalsalat', '/aflam', '/newrelases'];

function stripTags(s) { return (s || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim(); }

function scrapeCards(html) {
  const out = [];
  const anchorRe = /<a[^>]*href="[^"]*?\/(tvshow|movie)\/([a-z0-9-]+)(?:\/play\/\d+)?"[^>]*>/gi;
  let m;
  while ((m = anchorRe.exec(html)) !== null) {
    const type = m[1].toLowerCase() === 'movie' ? 'movie' : 'series';
    const slug = m[2];
    const before = html.slice(Math.max(0, m.index - 800), m.index);
    const after = html.slice(m.index, m.index + 900);
    const alts = [...before.matchAll(/alt="Poster for ([^"]*)"/gi)];
    const imgs = [...before.matchAll(/<img[^>]*src="([^"]+)"/gi)];
    let title = alts.length ? decodeEntities(alts[alts.length - 1][1]) : '';
    const poster = imgs.length ? imgs[imgs.length - 1][1] : null;
    if (!title) {
      const bh = [...before.matchAll(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/gi)];
      const ah = (after.match(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/i) || [])[1];
      const h = bh.length ? bh[bh.length - 1][1] : ah;
      title = h ? decodeEntities(stripTags(h)) : '';
    }
    const clean = (title || '').trim();
    const noEp = clean.replace(/\s*-?\s*حلقة\s*\d+$/, '').trim();
    out.push({ id: type + ':' + slug, type, slug, title: (!noEp || /^شاهد/.test(noEp)) ? slug : noEp, poster });
  }
  return out;
}

// Full-library paginated catalog. The site's listing pages expose an AJAX JSON
// endpoint: GET /mosalsalat?page=N (or /aflam) with X-Requested-With returns
// { pagination:{last_page}, videos:[...] } with 15 items per page. We serve any
// [skip, skip+limit) window lazily and cache each upstream page.
const LIST_ENDPOINT = { series: '/mosalsalat', movie: '/aflam' };
const PAGE_SIZE = 15;
const _pageCache = new Map();
const PAGE_TTL = 6 * 60 * 60 * 1000;

// Tiered freshness: new releases land on the first pages, so those refresh
// quickly; deep pages rarely change and stay cached longer.
function pageTtl(p) {
  if (p === 1) return 15 * 60 * 1000;        // 15 min
  if (p <= 5) return 2 * 3600 * 1000;        // 2 h
  return 12 * 3600 * 1000;                   // 12 h
}
function pageCacheGet(ep, p) {
  const e = _pageCache.get(ep + ':' + p);
  if (e && Date.now() - e.t < pageTtl(p)) return e.v;
  return null;
}
function pageCacheSet(ep, p, v) { _pageCache.set(ep + ':' + p, { v, t: Date.now() }); }
const _lastPage = new Map();

async function fetchPage(ep, p) {
  const hit = pageCacheGet(ep, p);
  if (hit) return hit;
  let vids = [];
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const data = await getJson(ep + '?page=' + p, BASE + ep);
      vids = (data && data.videos) || [];
      if (data && data.pagination && data.pagination.last_page) _lastPage.set(ep, data.pagination.last_page);
      if (vids.length) { pageCacheSet(ep, p, vids); return vids; }
    } catch (e) { /* retry */ }
    await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
  }
  return vids; // do NOT cache empty (avoids poisoning the cache on rate-limit)
}

// Fetch EVERY page of a listing (chunked concurrency) -> full library list.
async function getFull(ep, t) {
  await fetchPage(ep, 1);
  const last = _lastPage.get(ep) || 1;
  const pages = [];
  for (let p = 2; p <= last; p++) pages.push(p);
  for (let i = 0; i < pages.length; i += 10) {
    const chunk = pages.slice(i, i + 10);
    await Promise.all(chunk.map((p) => fetchPage(ep, p)));
    await new Promise((r) => setTimeout(r, 120));
  }
  const items = [];
  for (let p = 1; p <= last; p++) {
    for (const v of (pageCacheGet(ep, p) || [])) items.push(videoToItem(v, t));
  }
  return items;
}

const TMDB_W500 = 'https://image.tmdb.org/t/p/w500/';
// Compact poster encoding for the embedded index:
//   '@path' -> TMDB w500 image | '!url' -> other absolute url | 'path' -> BASE/storage/path
function compactPoster(u) {
  const abs = absPoster(u);
  if (!abs) return '';
  if (abs.indexOf(TMDB_W500) === 0) return '@' + abs.slice(TMDB_W500.length);
  if (abs.indexOf(BASE + '/storage/') === 0) return abs.slice((BASE + '/storage/').length);
  return '!' + abs;
}
function decodePoster(p) {
  if (!p) return '';
  if (p[0] === '@') return TMDB_W500 + p.slice(1);
  if (p[0] === '!') return p.slice(1);
  return BASE + '/storage/' + p;
}
// Arabic-aware title collation (Workers have limited ICU, so order is explicit).
const AR_ORDER = 'ابتثجحخدذرزسشصضطظعغفقكلمنهوي';
function normTitle(t) {
  let x = t || '';
  try { x = x.normalize('NFKC'); } catch (e) { /* no-op */ } // presentation forms -> base letters
  return x
    .replace(/[\u064B-\u0652\u0670\u0640]/g, '')
    .replace(/[أإآٱ]/g, 'ا').replace(/ى/g, 'ي').replace(/ؤ/g, 'و')
    .replace(/ئ/g, 'ي').replace(/ة/g, 'ه')
    .toLowerCase().trim();
}
function arKey(t) {
  const n = normTitle(t);
  let out = '';
  for (const ch of n) {
    const i = AR_ORDER.indexOf(ch);
    out += i >= 0 ? String.fromCharCode(0xe000 + i) : ch;
  }
  return out;
}
function byTitleAr(a, b) {
  const ka = arKey(a), kb = arKey(b);
  return ka < kb ? -1 : ka > kb ? 1 : 0;
}

function absPoster(u) {
  if (!u) return null;
  if (/^https?:/i.test(u)) return u;
  if (u.startsWith('//')) return 'https:' + u;
  if (u.startsWith('/')) return BASE + u;
  return BASE + '/storage/' + u;
}
function videoToItem(v, fallbackType) {
  const um = (v.url || '').match(/\/(tvshow|movie)\/([a-z0-9-]+)/i);
  const type = v.is_series ? 'series' : (um ? (um[1].toLowerCase() === 'movie' ? 'movie' : 'series') : fallbackType);
  const slug = um ? um[2] : String(v.id);
  return {
    id: type + ':' + slug, type, slug,
    title: decodeEntities(v.title || ''),
    poster: absPoster(v.poster_url || v.poster),
    year: v.year || undefined,
    description: decodeEntities(v.description || '') || undefined,
  };
}

async function getCatalog({ search, type, skip, limit } = {}) {
  if (search && search.trim()) return searchCatalog(search);
  const t = type === 'movie' ? 'movie' : 'series';
  const ep = LIST_ENDPOINT[t];
  skip = parseInt(skip || 0, 10) || 0;
  limit = parseInt(limit || 50, 10) || 50;
  if (limit >= 1000) {
    const all = await getFull(ep, t);
    return all.slice(skip, skip + limit);
  }
  const firstPage = Math.floor(skip / PAGE_SIZE) + 1;
  const lastPage = Math.floor((skip + limit - 1) / PAGE_SIZE) + 1;
  const startGlobal = (firstPage - 1) * PAGE_SIZE;
  const pageNos = [];
  for (let p = firstPage; p <= lastPage; p++) pageNos.push(p);
  const results = await Promise.all(pageNos.map(async (p) => {
    let vids = pageCacheGet(ep, p);
    if (!vids) {
      try {
        const data = await getJson(ep + '?page=' + p, BASE + ep);
        vids = (data && data.videos) || [];
        pageCacheSet(ep, p, vids);
      } catch (e) { vids = []; }
    }
    return vids;
  }));
  const concat = [];
  for (const vids of results) for (const v of vids) concat.push(videoToItem(v, t));
  return concat.slice(skip - startGlobal, skip - startGlobal + limit);
}

// Search via the site's JSON search endpoint.
async function searchCatalog(query) {
  const q = encodeURIComponent(query);
  // The search endpoint is paginated (per_page ~12); walk every page so nothing
  // is missed, then drop single-episode rows (/tvshow/<slug>/play/<id>).
  const first = await getJson('/search?query=' + q);
  const lastPage = Math.min(((first && first.pagination && first.pagination.last_page) || 1), 10);
  let vids = ((first && first.videos) || []).slice();
  for (let p = 2; p <= lastPage; p++) {
    try {
      const j = await getJson('/search?query=' + q + '&page=' + p);
      const more = (j && j.videos) || [];
      if (!more.length) break;
      vids = vids.concat(more);
    } catch (e) { break; }
  }
  const out = new Map();
  for (const v of vids) {
    const urlStr = v.url || '';
    if (/\/play\//i.test(urlStr)) continue;            // episode row, not a title
    const um = urlStr.match(/\/(tvshow|movie)\/([a-z0-9-]+)/i);
    if (!um) continue;                                    // unopenable shape
    const type = v.is_series === false || um[1].toLowerCase() === 'movie' ? 'movie' : 'series';
    const slug = um[2];
    const key = type + ':' + slug;
    if (out.has(key)) continue;                           // dedupe across pages
    const title = decodeEntities(v.title || v.name || '');
    if (!title) continue;
    out.set(key, {
      id: key, type, slug,
      title,
      poster: absPoster(v.poster_url || v.poster || v.cover || (v.poster_path ? 'https://image.tmdb.org/t/p/w500' + v.poster_path : null)) || undefined,
      year: v.year || v.release_year || undefined,
      description: decodeEntities(v.description || ''),
    });
  }
  return [...out.values()];
}

// ---- META (series) ----
// show page -> title/desc/poster + first episode play link
// player page -> season ids -> /series/season/{id} -> episodes
async function getSeriesMeta(slug) {
  const showHtml = await getHtml('/tvshow/' + slug);
  const title = metaContent(showHtml, 'og:title') || decodeEntities((showHtml.match(/<title>([^<]*)<\/title>/) || [])[1] || '') || slug;
  const description = metaContent(showHtml, 'og:description') || metaContent(showHtml, 'description') || '';
  let poster = metaContent(showHtml, 'og:image');
  // first episode player link
  const playLink = showHtml.match(/\/tvshow\/[a-z0-9-]+\/play\/(\d+)/i);
  const firstEpId = playLink ? playLink[1] : null;

  const meta = {
    id: 'series:' + slug,
    type: 'series',
    name: title.split('|')[0].trim(),
    poster,
    background: poster,
    description,
    slug,
    videos: [],
  };

  if (!firstEpId) return meta;

  // player page holds the season dropdown
  const playerHtml = await getHtml('/tvshow/' + slug + '/play/' + firstEpId, BASE + '/tvshow/' + slug);
  const seasons = [];
  const seasonRe = /data-season-id="(\d+)"[^>]*data-season-number="([^"]*)"/gi;
  let sm;
  while ((sm = seasonRe.exec(playerHtml)) !== null) {
    seasons.push({ id: sm[1], label: decodeEntities(sm[2]) });
  }
  // de-dupe, keep order
  const uniq = []; const sSeen = new Set();
  for (const s of seasons) { if (!sSeen.has(s.id)) { sSeen.add(s.id); uniq.push(s); } }
  meta.seasonIds = uniq.map((s) => s.id);

  // fetch episodes for each season
  let seasonNum = 1;
  for (const s of uniq) {
    let epData;
    try { epData = await getJson('/series/season/' + s.id + '?X-Requested-With=XMLHttpRequest', BASE + '/tvshow/' + slug + '/play/' + firstEpId); }
    catch (e) { seasonNum++; continue; }
    const eps = (epData && epData.episodes) || [];
    // try to read a real season number from the label
    const numMatch = (s.label || '').match(/(\d+)/);
    const sNum = numMatch ? parseInt(numMatch[1], 10) : seasonNum;
    for (const ep of eps) {
      meta.videos.push({
        id: 'series:' + slug + ':' + ep.id,
        title: decodeEntities(ep.title || ('الحلقة ' + ep.episode_number)),
        season: sNum,
        episode: ep.episode_number,
        episodeId: ep.id,
        slug,
      });
    }
    seasonNum++;
  }
  return meta;
}

// ---- META (movie) ----
async function getMovieMeta(slug) {
  const html = await getHtml('/movie/' + slug);
  const title = metaContent(html, 'og:title') || slug;
  const description = metaContent(html, 'og:description') || metaContent(html, 'description') || '';
  const poster = metaContent(html, 'og:image');
  // movie play link -> episode id
  // Movies play through /play/<slug> (an HTML page with the embed iframe), so a
  // numeric play id only exists for the rare legacy layout. Require a boundary
  // so '/play/6a5e8ef498a55' is not mistaken for episode id '6'.
  const playLink = html.match(/\/play\/(\d+)(?![a-z0-9])/i);
  const epId = playLink ? playLink[1] : null;
  const meta = {
    id: 'movie:' + slug,
    type: 'movie',
    name: title.split('|')[0].trim(),
    poster, background: poster, description, slug,
  };
  if (epId) meta.movieEpisodeId = epId;
  meta.moviePlaySlug = slug; // resolver fetches /play/<slug> for the embed
  return meta;
}

// ---- EPISODE -> stream link ----
// Returns { watch_url, download_url, can_watch, reason, series, season }
async function getEpisodeLink(episodeId) {
  const data = await getJson('/series/episode/' + episodeId, BASE + '/');
  const ep = data.episode || {};
  return {
    watch_url: ep.watch_url || null,
    download_url: ep.download_url || null,
    can_watch: ep.can_watch !== false,
    reason: ep.reason || null,
    title: decodeEntities(ep.title || ''),
    series: data.series || {},
    season: data.season || {},
  };
}

const CHUNK_PAGES = 30;
async function getLastPages() {
  await fetchPage('/mosalsalat', 1);
  await fetchPage('/aflam', 1);
  return { series: _lastPage.get('/mosalsalat') || 1, movie: _lastPage.get('/aflam') || 1 };
}
async function getCatalogChunk(type, chunk) {
  const t = type === 'movie' ? 'movie' : 'series';
  const ep = LIST_ENDPOINT[t];
  const lp = (await getLastPages())[t];
  const start = chunk * CHUNK_PAGES + 1;
  const end = Math.min(lp, (chunk + 1) * CHUNK_PAGES);
  if (start > lp) return [];
  const pages = [];
  for (let p = start; p <= end; p++) pages.push(p);
  for (let i = 0; i < pages.length; i += 10) {
    await Promise.all(pages.slice(i, i + 10).map((p) => fetchPage(ep, p)));
    await new Promise((r) => setTimeout(r, 120));
  }
  const items = [];
  for (let p = start; p <= end; p++) for (const v of (pageCacheGet(ep, p) || [])) items.push(videoToItem(v, t));
  return items;
}

module.exports = { BASE, compactPoster, decodePoster, byTitleAr, arKey, normTitle, TMDB_W500, getCatalog, searchCatalog, getSeriesMeta, getMovieMeta, getEpisodeLink, getHtml, getJson, decodeEntities, getLastPages, getCatalogChunk, CHUNK_PAGES, absPoster };
