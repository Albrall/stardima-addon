// Bundles libs + worker-router.js into ONE Cloudflare Worker module (ESM),
// injecting the embedded alphabetical catalog index.
// Output: ../stardima-deploy/worker-addon.js
const fs = require('fs');
const path = require('path');
const ROOT = __dirname;
const FILES = ['worker-router.js', 'lib/stardima.js', 'lib/resolver.js', 'lib/hosts.js', 'lib/unpacker.js'];

function idOf(fromId, req) {
  const dir = path.dirname(fromId);
  let p = path.normalize(path.join(dir, req)).replace(/\\/g, '/');
  if (!p.endsWith('.js')) p += '.js';
  return p;
}
function rewrite(code, fromId) {
  return code.replace(/require\(\s*(['"])([^'"]+)\1\s*\)/g, (m, q, req) => {
    if (req.startsWith('.')) return `__req(${JSON.stringify(idOf(fromId, req))})`;
    return `__realRequire(${JSON.stringify(req)})`;
  });
}

// worker-router.js contains `const INDEX = /*__INDEX__*/{};` — inject the real index
const idx = JSON.parse(fs.readFileSync(path.join(ROOT, 'catalog-index.min.json'), 'utf8'));
const idsData = JSON.parse(fs.readFileSync(path.join(ROOT, 'ids.json'), 'utf8'));
const idsPacked = Object.entries(idsData.map || {}).map(([k, v]) => {
  const digits = v.slice(2);
  return k + '=' + digits.length + Number(digits).toString(36);
}).join(',');
let genres = null, ourGenres = null, families = null, jcartoon = null, quality = null, ratings = null, dima = null;
try { ratings = JSON.parse(fs.readFileSync(path.join(ROOT, 'ratings.json'), 'utf8')); } catch (e) { /* optional */ }
try { quality = JSON.parse(fs.readFileSync(path.join(ROOT, 'quality.json'), 'utf8')); } catch (e) { /* optional */ }
try { families = JSON.parse(fs.readFileSync(path.join(ROOT, 'families.json'), 'utf8')); } catch (e) { /* optional */ }
try { genres = JSON.parse(fs.readFileSync(path.join(ROOT, 'genres.json'), 'utf8')); } catch (e) { /* optional */ }
try { jcartoon = JSON.parse(fs.readFileSync(path.join(ROOT, 'jcartoon.json'), 'utf8')); } catch (e) { /* optional */ }
let jcMap = null, jcSmap = null;
try { jcMap = JSON.parse(fs.readFileSync(path.join(ROOT, 'jc-map.json'), 'utf8')).items; } catch (e) { /* optional */ }
try { jcSmap = JSON.parse(fs.readFileSync(path.join(ROOT, 'jc-smap.json'), 'utf8')).items; } catch (e) { /* optional */ }
try { ourGenres = JSON.parse(fs.readFileSync(path.join(ROOT, 'our-genres.json'), 'utf8')); } catch (e) { /* optional */ }
try { dima = JSON.parse(fs.readFileSync(path.join(ROOT, 'dima.json'), 'utf8')); } catch (e) { /* optional */ }
let tmdbState = null;
try { tmdbState = JSON.parse(fs.readFileSync(path.join(ROOT, 'meta-tmdb-state.json'), 'utf8')).results || {}; } catch (e) { tmdbState = {}; }
let apiSeries = {};
try { apiSeries = JSON.parse(fs.readFileSync(path.join(ROOT, 'api-series-resolved.json'), 'utf8')); } catch (e) { apiSeries = {}; }
let semanticDeny = {};
try { semanticDeny = JSON.parse(fs.readFileSync(path.join(ROOT, 'semantic-deny.json'), 'utf8')); } catch (e) { semanticDeny = {}; }
// Compact bidirectional TMDB table: t/m + base36 id = local key.
const tmdbByKey = {};
for (const k in ((ratings && ratings.items) || {})) {
  const r = ratings.items[k]; if (!r || !r.id) continue;
  tmdbByKey[k.replace(/^stardima:/, '')] = (r.media === 'movie' ? 'm' : 't') + Number(r.id).toString(36);
}
for (const k in tmdbState) {
  if (tmdbByKey[k] || !tmdbState[k] || !tmdbState[k].tmdb) continue;
  const [media, id] = tmdbState[k].tmdb.split('/');
  if (id) tmdbByKey[k] = (media === 'movie' ? 'm' : 't') + Number(id).toString(36);
}
for (const k in apiSeries) {
  const a = apiSeries[k];
  if (tmdbByKey[k] || !a || !a.tmdb || (a.score || 0) < 0.8) continue;
  const [media, id] = a.tmdb.split('/');
  if (id) tmdbByKey[k] = (media === 'movie' ? 'm' : 't') + Number(id).toString(36);
}
// Never expose a movie TMDB id on a series card (or vice versa): Nuvio asks by
// both type and id, so a mismatched media type can never resolve correctly.
const seriesSlugs = new Set((idx.series && idx.series.items || []).map(x => x[0]));
const movieSlugs = new Set((idx.movies && idx.movies.items || []).map(x => x[0]));
for (const k in tmdbByKey) {
  if (semanticDeny[k]) { delete tmdbByKey[k]; continue; }
  const movieId = tmdbByKey[k][0] === 'm';
  const isSeries = seriesSlugs.has(k) || k.startsWith('jcseries-');
  const isMovie = movieSlugs.has(k) || k.startsWith('jcartoon-');
  if ((isSeries && movieId) || (isMovie && !movieId)) delete tmdbByKey[k];
}
// One external TMDB id may have been assigned to duplicate uploads. Keep exactly
// one route, preferring the work without an IMDb id (otherwise it would be unreachable).
const tmdbGroups = {};
for (const k in tmdbByKey) (tmdbGroups[tmdbByKey[k]] ||= []).push(k);
for (const keys of Object.values(tmdbGroups)) {
  if (keys.length < 2) continue;
  const keep = keys.find(k => !(idsData.map || {})[k]) || keys[0];
  for (const k of keys) if (k !== keep) delete tmdbByKey[k];
}
const tmdbPacked = Object.entries(tmdbByKey).map(([k, v]) => k + '=' + v).join(',');
const indexLiteral = JSON.stringify({ built: idx.built, series: idx.series, movies: idx.movies, genres: genres && { labels: genres.labels, items: genres.items }, ourGenres: ourGenres && { labels: ourGenres.labels, items: ourGenres.items },
                    families: families && { families: families.families, memberOf: families.memberOf, epMap: families.epMap, lang: families.lang },
                    jcartoon: jcartoon && { series: jcartoon.series, movies: jcartoon.movies, built: jcartoon.built, map: jcMap || {}, smap: jcSmap || {} },
                    quality: quality && { measured: quality.measured, items: quality.items },
                    ratings: ratings && { measured: ratings.measured, items: ratings.items },
                    dima: dima && { base: dima.base, series: dima.series, map: dima.map } });
function prep(f) {
  let code = fs.readFileSync(path.join(ROOT, f), 'utf8');
  if (f === 'worker-router.js') {
    if (!code.includes('/*__INDEX__*/{}')) throw new Error('index placeholder missing in worker-router.js');
    code = code.replace('/*__INDEX__*/{}', indexLiteral);
    if (!code.includes("/*__IDS__*/''")) throw new Error('ids placeholder missing in worker-router.js');
    code = code.replace("/*__IDS__*/''", JSON.stringify(idsPacked));
    if (!code.includes("/*__TMDB__*/''")) throw new Error('tmdb placeholder missing in worker-router.js');
    code = code.replace("/*__TMDB__*/''", JSON.stringify(tmdbPacked));
  }
  return rewrite(code, f);
}

const defs = FILES.map((f) => `  ${JSON.stringify(f)}: function (module, exports, __req) {\n${prep(f)}\n  }`).join(',\n');

const out = `// Stardima Addon - full addon as a single Cloudflare Worker (generated).
// Deploy: Cloudflare dashboard -> Workers & Pages -> stardima-proxy -> paste -> Deploy.
// Then use  https://<worker>.workers.dev/manifest.json  in Nuvio/Stremio.
const process = { env: {} }; // shim: Workers has no Node process
const __realRequire = (name) => { throw new Error('no builtin in worker: ' + name); };
const __defs = {
${defs}
};
const __cache = {};
function __req(id) {
  if (__cache[id]) return __cache[id].exports;
  const def = __defs[id]; if (!def) throw new Error('module not found: ' + id);
  const m = { exports: {} }; __cache[id] = m; def(m, m.exports, __req); return m.exports;
}
const __entry = __req('worker-router.js');
export default {
  async fetch(request, env, ctx) {
    try { return await __entry.fetch(request, env, ctx); }
    catch (e) { return new Response('worker error: ' + (e && e.message), { status: 500, headers: { 'access-control-allow-origin': '*' } }); }
  },
};
`;
const outPath = path.join(ROOT, '..', 'worker-addon.js');
fs.writeFileSync(outPath, out);
console.log('worker bundle written:', outPath, '(' + (out.length / 1024).toFixed(0) + ' KB)');
