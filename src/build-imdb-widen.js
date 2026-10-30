// Widen the IMDb coverage to works we never matched against TMDB.
//
//   Latin-titled work -> Cinemeta search (title + year)          -> tt id
//   Arabic-titled work -> TMDB /search/multi?language=ar (JSON)   -> TMDB id
//                      -> Wikidata P4983/P4947 -> P345            -> tt id
//                      -> (fallback) TMDB page in English
//                         -> Cinemeta search                      -> tt id
//
// Every link is verified: the year has to line up and the title has to actually
// match. A wrong tt id would pull another work's metadata and streams into the
// page, which is worse than no link at all.
//
//   node src/build-imdb-widen.js [limit] [offset]
const fs = require('fs');
const path = require('path');

const INDEX = path.join(__dirname, 'catalog-index.min.json');
const RATINGS = path.join(__dirname, 'ratings.json');
const TMDB_STATE = path.join(__dirname, 'meta-tmdb-state.json');
const IMDB_MAP = path.join(__dirname, 'imdb-map.json');       // "tv/123" -> tt
const OUT = path.join(__dirname, 'imdb-extra.json');          // slug -> {imdb, tmdb, via}
const STATE = path.join(__dirname, 'imdb-widen-state.json');  // resumable

const LIMIT = Number(process.argv[2] || 0);
const OFFSET = Number(process.argv[3] || 0);
const CONC = 5;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const load = (p, f) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return f; } };
const isArabic = (t) => /[\u0600-\u06FF]/.test(t || '');

function normAr(s) {
  return String(s || '')
    .replace(/[\u064B-\u0652\u0670\u0640]/g, '')            // تشكيل + تطويل
    .replace(/[أإآٱ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه')
    .replace(/ؤ/g, 'و').replace(/ئ/g, 'ي')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\b(المسلسل|مسلسل|الفيلم|فيلم|كرتون|انمي|انيمي|مترجم|مدبلج|كامل|كامله|الجزء|جزء|برنامج|سبيشل)\b/g, ' ')
    .replace(/\s+/g, ' ').trim();
}
function normEn(s) {
  return String(s || '').toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\b(the|a|an|movie|film|series|season|part|tv)\b/g, ' ')
    .replace(/\s+/g, ' ').trim();
}
function titleMatch(ours, theirs) {
  const a = isArabic(ours) ? normAr(ours) : normEn(ours);
  const b = isArabic(theirs) ? normAr(theirs) : normEn(theirs);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) return 0.9;
  const A = new Set(a.split(' ').filter((w) => w.length > 2));
  const B = new Set(b.split(' ').filter((w) => w.length > 2));
  if (!A.size || !B.size) return 0;
  let shared = 0; for (const w of A) if (B.has(w)) shared++;
  return shared / Math.min(A.size, B.size);
}
const yearOf = (x) => {
  const s = x && (x.release_date || x.first_air_date || x.releaseInfo || x.airDate);
  if (!s) return 0;
  const m = /(\d{4})/.exec(String(s));
  return m ? Number(m[1]) : 0;
};
function yearOk(a, b) {
  const x = Number(a) || 0, y = Number(b) || 0;
  if (!x || !y) return true;                 // one side has no year: title decides
  return Math.abs(x - y) <= 2;
}

async function getJson(u, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      // Wikidata answers 403 to a request with no User-Agent at all
      const headers = /wikidata\.org/.test(u) ? { 'User-Agent': 'stardima-addon/1.0 (metadata)' } : {};
      const r = await fetch(u, { headers });
      if (!r.ok) { await sleep(600 * (i + 1)); continue; }
      const t = await r.text();
      try { return JSON.parse(t); } catch (e) { return null; }
    } catch (e) { await sleep(600 * (i + 1)); }
  }
  return null;
}
async function getText(u, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(u);            // no custom UA: TMDB 403s the usual one
      if (!r.ok) { await sleep(600 * (i + 1)); continue; }
      return await r.text();
    } catch (e) { await sleep(600 * (i + 1)); }
  }
  return null;
}

// ---- Cinemeta: title -> tt -------------------------------------------------
async function cinemetaSearch(title, type, year) {
  const ctype = type === 'movies' ? 'movie' : 'series';
  const j = await getJson('https://v3-cinemeta.strem.io/catalog/' + ctype + '/top/search=' + encodeURIComponent(title) + '.json');
  const metas = (j && j.metas) || [];
  let best = null, bestScore = 0;
  for (const m of metas) {
    const sim = titleMatch(title, m.name);
    if (!yearOk(year, yearOf({ releaseInfo: m.releaseInfo }))) continue;
    if (sim > bestScore) { best = m; bestScore = sim; }
  }
  return bestScore >= 0.9 && best ? { imdb: best.id, conf: bestScore, via: 'cinemeta' } : null;
}

// ---- TMDB: title -> tmdb id ------------------------------------------------
async function tmdbSearch(title) {
  const j = await getJson('https://www.themoviedb.org/search/multi?query=' + encodeURIComponent(title) + '&language=ar');
  const rows = (j && j.results) || [];
  return rows.map((x) => {
    const media = x.media_type || (x.title ? 'movie' : (x.name ? 'tv' : null));
    return media ? { media, id: x.id, name: x.title || x.name, original: x.original_title || x.original_name, year: yearOf(x) } : null;
  }).filter(Boolean);
}
async function tmdbEnglishTitle(media, id) {
  const html = await getText('https://www.themoviedb.org/' + (media === 'movie' ? 'movie' : 'tv') + '/' + id + '?language=en-US');
  if (!html) return null;
  const m = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
  if (!m) return null;
  try { const j = JSON.parse(m[1].replace(/\/\*[\s\S]*?\*\//g, '')); return { title: j.name, year: yearOf({ first_air_date: j.startDate || j.dateCreated }) }; }
  catch (e) { return null; }
}

// ---- Wikidata: tmdb id -> tt ----------------------------------------------
const WQ = 'https://query.wikidata.org/sparql';
async function wikidataImdb(pairs) {
  const out = {};
  const byProp = { tv: [], movie: [] };
  for (const p of pairs) { const [m, id] = p.split('/'); if (byProp[m]) byProp[m].push(id); }
  for (const media of ['tv', 'movie']) {
    const prop = media === 'tv' ? 'P4983' : 'P4947';
    for (let i = 0; i < byProp[media].length; i += 100) {
      const chunk = byProp[media].slice(i, i + 100);
      const q = `SELECT ?tmdb ?imdb WHERE { VALUES ?tmdb { ${chunk.map((x) => '"' + x + '"').join(' ')} } ?item wdt:${prop} ?tmdb ; wdt:P345 ?imdb . }`;
      const j = await getJson(WQ + '?format=json&query=' + encodeURIComponent(q) + '&_=' + Date.now(), 4);
      const rows = (j && j.results && j.results.bindings) || [];
      for (const r of rows) if (/^tt\d+$/.test(r.imdb.value)) out[media + '/' + r.tmdb.value] = r.imdb.value;
      await sleep(400);
    }
  }
  return out;
}

(async () => {
  const I = load(INDEX, { series: { items: [] }, movies: { items: [] } });
  const ratings = load(RATINGS, { items: {} }).items || {};
  const tmdbState = load(TMDB_STATE, { results: {} }).results || {};
  const imdbMap = load(IMDB_MAP, {});
  const out = load(OUT, {});
  const state = load(STATE, { done: {} });

  const tmdbOfSlug = (slug) => {
    const r = ratings['stardima:' + slug];
    if (r && r.id) return (r.media || 'tv') + '/' + r.id;
    const t = tmdbState[slug] && tmdbState[slug].tmdb;
    return t || null;
  };
  const hasImdb = (slug) => {
    if (out[slug] && out[slug].imdb) return true;
    const t = tmdbOfSlug(slug);
    return !!(t && (imdbMap[t] || out[slug]));
  };

  const jobs = [];
  for (const kind of ['series', 'movies']) {
    for (const it of (I[kind].items || [])) {
      const [slug, title, , year] = it;
      if (!title || hasImdb(slug) || state.done[slug]) continue;
      jobs.push({ slug, title, year: Number(year) || 0, type: kind });
    }
  }
  const todo = jobs.slice(OFFSET, LIMIT ? OFFSET + LIMIT : undefined);
  console.log(`works without an IMDb id: ${jobs.length} · this run: ${todo.length}`);

  const newPairs = new Set();
  let done = 0, hits = 0, cinemetaHits = 0, tmdbHits = 0;
  const queue = todo.slice();
  async function worker() {
    while (queue.length) {
      const job = queue.shift();
      if (!job) return;
      try {
        let hit = null;
        if (!isArabic(job.title)) {
          hit = await cinemetaSearch(job.title, job.type, job.year);
          if (hit) cinemetaHits++;
        }
        if (!hit) {
          const rows = await tmdbSearch(job.title);
          let best = null, bestScore = 0;
          for (const r of rows) {
            if (job.type === 'movies' && r.media !== 'movie') continue;
            if (job.type === 'series' && r.media !== 'tv') continue;
            if (!yearOk(job.year, r.year)) continue;
            const sim = Math.max(titleMatch(job.title, r.name), titleMatch(job.title, r.original));
            if (sim > bestScore) { best = r; bestScore = sim; }
          }
          if (best && bestScore >= 0.85) {
            const key = best.media + '/' + best.id;
            out[job.slug] = { tmdb: key, conf: bestScore, via: 'tmdb-search' };
            newPairs.add(key);
            tmdbHits++;
            hit = { pending: key };
          }
        }
        if (hit && hit.imdb) { out[job.slug] = { imdb: hit.imdb, conf: hit.conf, via: hit.via }; hits++; }
        else if (hit && hit.pending) { /* resolved after the Wikidata pass */ }
        state.done[job.slug] = true;
        done++;
        if (done % 25 === 0) {
          fs.writeFileSync(OUT, JSON.stringify(out));
          fs.writeFileSync(STATE, JSON.stringify(state));
          process.stdout.write(`  ${done}/${todo.length} · tmdb ${tmdbHits} · cinemeta ${cinemetaHits}\r`);
        }
      } catch (e) { /* network hiccup — leave it for the next run */ }
      await sleep(120);
    }
  }
  await Promise.all(Array.from({ length: CONC }, worker));

  // resolve the TMDB ids we just discovered
  if (newPairs.size) {
    console.log(`\nlooking up ${newPairs.size} new TMDB ids in Wikidata…`);
    const found = await wikidataImdb([...newPairs]);
    for (const slug in out) {
      const e = out[slug];
      if (e.imdb || !e.tmdb) continue;
      if (found[e.tmdb]) { e.imdb = found[e.tmdb]; e.via = 'tmdb-search+wikidata'; hits++; }
    }
    // whatever Wikidata does not know: TMDB's English title -> Cinemeta
    const leftovers = Object.keys(out).filter((s) => out[s].tmdb && !out[s].imdb);
    if (leftovers.length) {
      console.log(`${leftovers.length} still without an id — asking Cinemeta by their English title…`);
      for (const slug of leftovers) {
        const [media, id] = out[slug].tmdb.split('/');
        const en = await tmdbEnglishTitle(media, id);
        if (!en || !en.title) continue;
        const c = await cinemetaSearch(en.title, media === 'movie' ? 'movies' : 'series', en.year);
        if (c) { out[slug].imdb = c.imdb; out[slug].via = 'tmdb-search+cinemeta'; out[slug].en = en.title; hits++; }
        await sleep(120);
      }
    }
    for (const p of newPairs) if (!out.__tmdbResolved) { /* noop */ }
    const merged = Object.assign({}, load(IMDB_MAP, {}), found);
    fs.writeFileSync(IMDB_MAP, JSON.stringify(merged));
  }
  fs.writeFileSync(OUT, JSON.stringify(out));
  fs.writeFileSync(STATE, JSON.stringify(state));
  const total = Object.values(out).filter((x) => x.imdb).length;
  console.log(`\nnew IMDb ids: ${hits} · file now holds ${total} ids for ${Object.keys(out).length} tried works`);
})();
