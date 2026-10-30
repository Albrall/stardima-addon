// Turn the TMDB ids we already matched into IMDb ids, which is the id space Stremio
// clients (and so Nuvio) use to merge the same work across addons.
//
//   TMDB id --(Wikidata P4983 tv / P4947 movie)--> P345 IMDb id
//
// Wikidata is curated, so every id it hands back is exact — no guessing. Anything it
// does not know is left for build-imdb-fill.js, which searches by title.
//   node src/build-imdb.js
const fs = require('fs');
const path = require('path');

const RATINGS = path.join(__dirname, 'ratings.json');
const TMDB_STATE = path.join(__dirname, 'meta-tmdb-state.json');
const OUT = path.join(__dirname, 'imdb-map.json');
const STATE = path.join(__dirname, 'imdb-state.json');

const UA = 'stardima-addon/1.0 (metadata; contact none)';
const ENDPOINT = 'https://query.wikidata.org/sparql';
const BATCH = 100;
const PROP = { tv: 'P4983', movie: 'P4947' };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function load(p, fallback) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return fallback; } }

// every distinct TMDB id we hold, split by media type
function collect() {
  const out = { tv: new Set(), movie: new Set() };
  const ratings = load(RATINGS, { items: {} }).items || {};
  for (const k in ratings) {
    const it = ratings[k];
    if (!it || !it.id) continue;
    const media = it.media === 'movie' ? 'movie' : 'tv';
    out[media].add(String(it.id));
  }
  const st = load(TMDB_STATE, { results: {} }).results || {};
  for (const k in st) {
    const t = st[k] && st[k].tmdb;
    if (!t) continue;
    const [media, id] = String(t).split('/');
    if (!id || !out[media]) continue;
    out[media].add(String(id));
  }
  return { tv: [...out.tv], movie: [...out.movie] };
}

async function sparql(query, tries = 4) {
  for (let a = 0; a < tries; a++) {
    try {
      const res = await fetch(ENDPOINT + '?format=json&query=' + encodeURIComponent(query), {
        headers: { 'User-Agent': UA, Accept: 'application/sparql-results+json' },
      });
      if (res.status === 429 || res.status >= 500) { await sleep(2000 * (a + 1)); continue; }
      if (!res.ok) return null;
      const j = await res.json();
      return (j.results && j.results.bindings) || [];
    } catch (e) { await sleep(1500 * (a + 1)); }
  }
  return null;
}

(async () => {
  const state = load(STATE, { done: {}, failed: {} });
  const map = load(OUT, {});
  const { tv, movie } = collect();
  console.log(`distinct TMDB ids: ${tv.length} tv, ${movie.length} movie`);

  for (const media of ['tv', 'movie']) {
    const ids = (media === 'tv' ? tv : movie).filter((id) => !state.done[media + '/' + id]);
    console.log(`${media}: ${ids.length} to look up`);
    for (let i = 0; i < ids.length; i += BATCH) {
      const chunk = ids.slice(i, i + BATCH);
      const values = chunk.map((x) => `"${x}"`).join(' ');
      const q = `SELECT ?tmdb ?imdb WHERE { VALUES ?tmdb { ${values} } ?item wdt:${PROP[media]} ?tmdb ; wdt:P345 ?imdb . }`;
      const rows = await sparql(q);
      if (!rows) { chunk.forEach((id) => { state.failed[media + '/' + id] = true; }); console.log(`  batch ${i} failed`); continue; }
      for (const r of rows) {
        const key = media + '/' + r.tmdb.value;
        const imdb = r.imdb.value;
        if (/^tt\d+$/.test(imdb)) map[key] = imdb;
      }
      chunk.forEach((id) => { state.done[media + '/' + id] = true; });
      process.stdout.write(`  ${media} ${Math.min(i + BATCH, ids.length)}/${ids.length} (${rows.length} hits)\r`);
      fs.writeFileSync(OUT, JSON.stringify(map));
      fs.writeFileSync(STATE, JSON.stringify(state));
      await sleep(400);
    }
    console.log(`\n${media}: done`);
  }
  console.log(`\ntotal IMDb ids: ${Object.keys(map).length}`);
  fs.writeFileSync(OUT, JSON.stringify(map));
  fs.writeFileSync(STATE, JSON.stringify(state));
})();
