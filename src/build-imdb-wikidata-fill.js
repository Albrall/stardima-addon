// Fill the TMDB ids the widen pass found but could not translate: Wikidata refuses a
// request without a User-Agent, so those lookups came back empty. Same curated mapping
// as build-imdb.js, run again over whatever is still pending.
//   node src/build-imdb-wikidata-fill.js
const fs = require('fs');
const path = require('path');

const EXTRA = path.join(__dirname, 'imdb-extra.json');
const IMDB_MAP = path.join(__dirname, 'imdb-map.json');
const UA = 'stardima-addon/1.0 (metadata; contact none)';
const PROP = { tv: 'P4983', movie: 'P4947' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function sparql(q, tries = 4) {
  for (let a = 0; a < tries; a++) {
    try {
      const r = await fetch('https://query.wikidata.org/sparql?format=json&query=' + encodeURIComponent(q), {
        headers: { 'User-Agent': UA, Accept: 'application/sparql-results+json' },
      });
      if (r.status === 429 || r.status >= 500) { await sleep(2000 * (a + 1)); continue; }
      if (!r.ok) return null;
      const j = await r.json();
      return (j.results && j.results.bindings) || [];
    } catch (e) { await sleep(1500 * (a + 1)); }
  }
  return null;
}

(async () => {
  const extra = JSON.parse(fs.readFileSync(EXTRA, 'utf8'));
  const map = JSON.parse(fs.readFileSync(IMDB_MAP, 'utf8'));
  const pending = [...new Set(Object.values(extra).filter((e) => e.tmdb && !e.imdb).map((e) => e.tmdb))];
  console.log('pending TMDB ids:', pending.length);
  let filled = 0;
  for (const media of ['tv', 'movie']) {
    const ids = pending.filter((k) => k.startsWith(media + '/')).map((k) => k.split('/')[1]);
    for (let i = 0; i < ids.length; i += 100) {
      const chunk = ids.slice(i, i + 100);
      const q = `SELECT ?tmdb ?imdb WHERE { VALUES ?tmdb { ${chunk.map((x) => '"' + x + '"').join(' ')} } ?item wdt:${PROP[media]} ?tmdb ; wdt:P345 ?imdb . }`;
      const rows = await sparql(q);
      if (!rows) { console.log('  batch failed', i); continue; }
      for (const r of rows) if (/^tt\d+$/.test(r.imdb.value)) { map[media + '/' + r.tmdb.value] = r.imdb.value; filled++; }
      await sleep(400);
    }
  }
  for (const slug in extra) {
    const e = extra[slug];
    if (!e.imdb && e.tmdb && map[e.tmdb]) { e.imdb = map[e.tmdb]; e.via = 'tmdb-search+wikidata'; }
  }
  fs.writeFileSync(EXTRA, JSON.stringify(extra));
  fs.writeFileSync(IMDB_MAP, JSON.stringify(map));
  const total = Object.values(extra).filter((e) => e.imdb).length;
  console.log(`filled ${filled} ids from Wikidata · ${total} works in imdb-extra.json now carry an IMDb id`);
})();
