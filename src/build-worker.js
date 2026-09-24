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
let genres = null;
try { genres = JSON.parse(fs.readFileSync(path.join(ROOT, 'genres.json'), 'utf8')); } catch (e) { /* optional */ }
const indexLiteral = JSON.stringify({ built: idx.built, series: idx.series, movies: idx.movies, genres: genres && { labels: genres.labels, items: genres.items } });
function prep(f) {
  let code = fs.readFileSync(path.join(ROOT, f), 'utf8');
  if (f === 'worker-router.js') {
    if (!code.includes('/*__INDEX__*/{}')) throw new Error('index placeholder missing in worker-router.js');
    code = code.replace('/*__INDEX__*/{}', indexLiteral);
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
