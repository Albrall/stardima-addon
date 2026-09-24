/* Build a compact, alphabetically-ordered catalog index for embedding in the
 * Worker. Fetches every listing page from the sandbox (which is not rate
 * limited the way the Cloudflare edge IP is) and stores the minimum fields
 * needed to render catalog cards: slug, title, poster, year. */
const { BASE, AJAX, absPoster } = require('./lib/stardima');

const POSTER_PREFIX = BASE + '/storage/';

// Arabic-aware title normalisation + collation (Cloudflare Workers have only
// limited ICU, so the letter order is spelled out explicitly).
const AR_ORDER = 'ابتثجحخدذرزسشصضطظعغفقكلمنهوي';
function normTitle(t) {
  return (t || '')
    .replace(/[\u064B-\u0652\u0670\u0640]/g, '') // tashkeel + tatweel
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

function slugFromUrl(url) {
  if (!url) return '';
  const m = String(url).split('/').filter(Boolean);
  return m[m.length - 1] || '';
}
function packPoster(p) {
  const abs = absPoster(p);
  if (!abs) return '';
  return abs.startsWith(POSTER_PREFIX) ? abs.slice(POSTER_PREFIX.length) : '!' + abs;
}

async function jget(u) {
  const r = await fetch(u, { headers: { 'Accept': 'application/json', 'X-Requested-With': 'XMLHttpRequest', 'User-Agent': 'Mozilla/5.0' } });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function build(ep, label) {
  const first = await jget(`${BASE}/${ep}?page=1`);
  const lastPage = (first.pagination && first.pagination.last_page) || 1;
  const bySlug = new Map();
  const add = (videos) => (videos || []).forEach(v => {
    const slug = slugFromUrl(v.url);
    if (!slug) return;
    bySlug.set(slug, [slug, (v.title || '').trim(), packPoster(v.poster_url || v.poster), String(v.year || '')]);
  });
  add(first.videos);
  const queue = [];
  for (let p = 2; p <= lastPage; p++) queue.push(p);
  let done = 1;
  const CONC = 5;
  async function worker() {
    while (queue.length) {
      const p = queue.shift();
      for (let a = 0; a < 3; a++) {
        try { add((await jget(`${BASE}/${ep}?page=${p}`)).videos); break; }
        catch (e) { if (a === 2) console.error(`  page ${p} failed: ${e.message}`); await sleep(800); }
      }
      if (++done % 25 === 0 || done === lastPage) console.log(`  ${label}: ${done}/${lastPage} pages`);
      await sleep(120);
    }
  }
  await Promise.all(Array.from({ length: CONC }, worker));
  const items = [...bySlug.values()].sort((a, b) => (arKey(a[1]) < arKey(b[1]) ? -1 : arKey(a[1]) > arKey(b[1]) ? 1 : 0));
  console.log(`${label}: ${items.length} items (last_page=${lastPage})`);
  return { last_page: lastPage, count: items.length, items };
}

(async () => {
  const t0 = Date.now();
  const series = await build('mosalsalat', 'series');
  const movies = await build('aflam', 'movies');
  const index = { built: new Date().toISOString(), base: BASE, series, movies };
  require('fs').writeFileSync(__dirname + '/catalog-index.json', JSON.stringify(index));
  // compact copy — this is what build-worker.js embeds
  require('fs').writeFileSync(__dirname + '/catalog-index.min.json', JSON.stringify(index));
  const kb = (require('fs').statSync(__dirname + '/catalog-index.json').size / 1024).toFixed(0);
  console.log(`index written: ${kb} KB in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log('first 3 series:', series.items.slice(0, 3).map(i => i[1]));
  console.log('first 3 movies:', movies.items.slice(0, 3).map(i => i[1]));
})();
