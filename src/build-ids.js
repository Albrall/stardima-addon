// Builds src/ids.json: work -> IMDb id, for every work we can link honestly.
//
// Sources, in order of trust:
//   1. imdb-map.json  — TMDB id -> IMDb id via Wikidata (curated, exact)
//   2. imdb-extra.json — found by build-imdb-widen.js (TMDB search / Cinemeta)
//
// Before an id is accepted it is checked against Cinemeta's own entry: for a work we
// hold under a Latin title the names have to line up, and the year has to agree within
// two years for every work. A wrong id would pull another title's metadata and streams
// onto the page, which is worse than staying on our own ids.
//
//   node src/build-ids.js
const fs = require('fs');
const path = require('path');

const INDEX = path.join(__dirname, 'catalog-index.min.json');
const RATINGS = path.join(__dirname, 'ratings.json');
const TMDB_STATE = path.join(__dirname, 'meta-tmdb-state.json');
const IMDB_MAP = path.join(__dirname, 'imdb-map.json');
const IMDB_EXTRA = path.join(__dirname, 'imdb-extra.json');
const GEMINI = path.join(__dirname, 'gemini-title-resolved.json');
const API_SERIES = path.join(__dirname, 'api-series-resolved.json');
const SEMANTIC_DENY = path.join(__dirname, 'semantic-deny.json');
const JCARTON = path.join(__dirname, 'jcartoon.json');
const OUT = path.join(__dirname, 'ids.json');
const CACHE = path.join(__dirname, 'cinemeta-cache.json');

const load = (p, f) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return f; } };
const isArabic = (t) => /[\u0600-\u06FF]/.test(t || '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function norm(s) {
  return String(s || '').toLowerCase()
    .replace(/[\u064B-\u0652\u0670\u0640]/g, '')
    .replace(/[أإآٱ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\b(the|a|an|movie|film|series|season|part|tv|المسلسل|مسلسل|الفيلم|فيلم)\b/g, ' ')
    .replace(/\s+/g, ' ').trim();
}
function sim(a, b) {
  const A = norm(a), B = norm(b);
  if (!A || !B) return 0;
  if (A === B) return 1;
  if (A.includes(B) || B.includes(A)) return 0.9;
  const as = new Set(A.split(' ').filter((w) => w.length > 2));
  const bs = new Set(B.split(' ').filter((w) => w.length > 2));
  if (!as.size || !bs.size) return 0;
  let shared = 0; for (const w of as) if (bs.has(w)) shared++;
  return shared / Math.min(as.size, bs.size);
}
const yearOf = (s) => { const m = /(\d{4})/.exec(String(s || '')); return m ? Number(m[1]) : 0; };

async function cinemeta(type, id, cache) {
  const key = type + ':' + id;
  if (cache[key] !== undefined) return cache[key];
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch('https://cinemeta-live.strem.io/meta/' + type + '/' + id + '.json');
      if (!r.ok) { await sleep(500); continue; }
      const j = await r.json();
      const meta = j && j.meta;
      const val = meta ? { name: meta.name || '', year: yearOf(meta.releaseInfo), type: meta.type } : null;
      cache[key] = val;
      return val;
    } catch (e) { await sleep(500); }
  }
  cache[key] = null;
  return null;
}

(async () => {
  const I = load(INDEX, { series: { items: [] }, movies: { items: [] } });
  const ratings = load(RATINGS, { items: {} }).items || {};
  const tmdbState = load(TMDB_STATE, { results: {} }).results || {};
  const imdbMap = load(IMDB_MAP, {});
  const extra = load(IMDB_EXTRA, {});
  const gemini = load(GEMINI, { accepted: {} }).accepted || {};
  const apiSeries = load(API_SERIES, {});
  const semanticDeny = load(SEMANTIC_DENY, {});
  const jc = load(JCARTON, { series: [], movies: [] });
  const cache = load(CACHE, {});

  const map = {}, rev = {}, dropped = [];
  const stats = { works: 0, linked: 0, viaWikidata: 0, viaExtra: 0, viaGemini: 0, viaApi: 0, checked: 0, rejected: 0 };

  // candidate: { key, title, year, type, imdb, via }  type is 'series' | 'movie'
  const cands = [];
  const tmdbKeyOf = (slug) => {
    const r = ratings['stardima:' + slug];
    if (r && r.id) return { key: (r.media || 'tv') + '/' + r.id, media: r.media || 'tv' };
    const t = tmdbState[slug] && tmdbState[slug].tmdb;
    if (t) { const [media, id] = String(t).split('/'); return { key: media + '/' + id, media }; }
    return null;
  };
  for (const section of ['series', 'movies']) {
    const want = section === 'series' ? 'tv' : 'movie';
    for (const it of (I[section].items || [])) {
      const [slug, title, , year] = it;
      stats.works++;
      if (section === 'series' && semanticDeny[slug]) continue;
      let imdb = null, via = null;
      const a = section === 'series' ? apiSeries[slug] : null;
      if (a && a.imdb && (a.score || 0) >= 0.8) { imdb = a.imdb; via = 'api'; }
      const g = section === 'series' ? gemini[slug] : null;
      if (!imdb && g && g.imdb) { imdb = g.imdb; via = 'gemini'; }
      const e = extra[slug];
      if (!imdb && e && e.imdb) { imdb = e.imdb; via = 'extra'; }
      if (!imdb) {
        const t = tmdbKeyOf(slug);
        // only link when TMDB also thinks it is the same shape as we do
        if (t && t.media === want && imdbMap[t.key]) { imdb = imdbMap[t.key]; via = 'wikidata'; }
      }
      if (imdb) cands.push({ key: slug, title, year: Number(year) || 0, type: section === 'series' ? 'series' : 'movie', imdb, via });
    }
  }
  // jcartoon-only works (the 1080p source) carry their own ratings entries
  for (const section of ['series', 'movies']) {
    const want = section === 'series' ? 'tv' : 'movie';
    for (const x of (jc[section] || [])) {
      const r = ratings[(section === 'series' ? 'jcseries-' : 'jcartoon-') + x.id];
      if (!r || !r.id || (r.media || 'tv') !== want) continue;
      const imdb = imdbMap[(r.media || 'tv') + '/' + r.id];
      if (imdb) cands.push({ key: (section === 'series' ? 'jcseries-' : 'jcartoon-') + x.id, title: x.title, year: Number(r.year) || 0, type: section === 'series' ? 'series' : 'movie', imdb, via: 'wikidata' });
    }
  }

  console.log(`candidates: ${cands.length} — checking each against Cinemeta…`);
  const CONC = 8;
  let cursor = 0;
  async function checkOne() {
    while (cursor < cands.length) {
      const c = cands[cursor++];
      stats.checked++;
      const cm = await cinemeta(c.type, c.imdb, cache);
      let ok = true, why = '';
      if (cm) {
        const y = cm.year;
        if (c.year && y && Math.abs(y - c.year) > 2) { ok = false; why = `year ${y} vs ${c.year}`; }
        if (ok && !isArabic(c.title)) {
          const s = sim(c.title, cm.name);
          if (s < 0.34) { ok = false; why = `name "${cm.name}" (sim ${s.toFixed(2)})`; }
        }
      }
      if (!ok) { dropped.push({ key: c.key, title: c.title, imdb: c.imdb, why }); stats.rejected++; continue; }
      if (rev[c.imdb] && rev[c.imdb] !== c.key) { continue; }   // one work per IMDb id
      map[c.key] = c.imdb;
      rev[c.imdb] = c.key;
      stats.linked++;
      if (c.via === 'wikidata') stats.viaWikidata++; else if (c.via === 'gemini') stats.viaGemini++; else if (c.via === 'api') stats.viaApi++; else stats.viaExtra++;
      if (stats.checked % 200 === 0) process.stdout.write(`  ${stats.checked}/${cands.length}\r`);
    }
  }
  await Promise.all(Array.from({ length: CONC }, checkOne));

  const out = {
    built: new Date().toISOString(),
    map, rev,
    stats: { ...stats, coverage: stats.works ? +(100 * stats.linked / stats.works).toFixed(1) : 0 },
    dropped,
  };
  fs.writeFileSync(OUT, JSON.stringify(out));
  fs.writeFileSync(CACHE, JSON.stringify(cache));
  console.log(`linked ${stats.linked} works (${out.stats.coverage}% of ${stats.works}) · wikidata ${stats.viaWikidata} · search ${stats.viaExtra} · Gemini ${stats.viaGemini} · APIs ${stats.viaApi} · rejected ${stats.rejected}`);
  if (dropped.length) { console.log('rejected samples:'); dropped.slice(0, 8).forEach((d) => console.log(`  ${d.title} → ${d.imdb}: ${d.why}`)); }
})();
