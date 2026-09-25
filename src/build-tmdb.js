// Classifies the library from TMDB's public pages (no API key needed):
//   /search?query=<title>&language=ar  -> ordered candidate ids
//   /(tv|movie)/<id>?language=ar       -> Arabic genre labels + the localised
//                                         name/year used to verify the match
// Resumable: work is checkpointed in meta-tmdb-state.json.
//   node build-tmdb.js 800     -> process the next 800 unprocessed titles
const fs = require('fs');
const path = require('path');
const { normTitle } = require('./lib/stardima');

const STATE = path.join(__dirname, 'meta-tmdb-state.json');
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';
const CONC = 7;
const isArabic = (t) => /[\u0600-\u06FF]/.test(t || '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const GENRE_MAP = {
  'أكشن': 'أكشن', 'اكشن': 'أكشن', 'مغامرة': 'مغامرة', 'مغامرات': 'مغامرة', 'كوميديا': 'كوميدي',
  'جريمة': 'غموض وتحقيق', 'غموض': 'غموض وتحقيق', 'إثارة': 'غموض وتحقيق', 'اثارة': 'غموض وتحقيق',
  'دراما': 'دراما', 'فانتازيا': 'فانتازيا', 'خيال': 'فانتازيا', 'تاريخ': 'تاريخي', 'رعب': 'رعب',
  'موسيقى': 'موسيقي', 'رومانسي': 'رومانسي', 'خيال علمي': 'خيال علمي', 'حرب': 'أكشن',
  'رياضة': 'رياضة', 'رياضي': 'رياضة', 'عائلي': null, 'رسوم متحركة': null, 'أنيمي': null,
  'وثائقي': null, 'غربي': null, 'تلفزيون الواقع': null, 'فنون القتال': 'أكشن', 'طبخ': 'طبخ',
};
function tokens(s) { return normTitle(s).replace(/[^\p{L}\p{N} ]/gu, ' ').split(/\s+/).filter((t) => t && t.length >= 2); }
function similarTitle(a, b) {
  const na = normTitle(a).replace(/[^\p{L}\p{N} ]/gu, ' ').replace(/\s+/g, ' ').trim();
  const nb = normTitle(b).replace(/[^\p{L}\p{N} ]/gu, ' ').replace(/\s+/g, ' ').trim();
  if (!na || !nb) return false;
  if (na === nb || na.includes(nb) || nb.includes(na)) return true;
  const A = new Set(tokens(a)), B = new Set(tokens(b));
  for (const t of A) if (B.has(t) && (t.length >= 4 || /^\d+$/.test(t))) return true;
  return false;
}
function load() { try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch (e) { return { results: {}, tried: {} }; } }
function save(s) { fs.writeFileSync(STATE, JSON.stringify(s)); }
async function req(url, tries = 3) {
  for (let a = 0; a < tries; a++) {
    try {
      const res = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': UA, 'Accept-Language': 'ar,en;q=0.8' } });
      if (res.status === 429 || res.status === 503) { await sleep(1200 * (a + 1)); continue; }
      if (!res.ok) return null;
      return await res.text();
    } catch (e) { await sleep(500 * (a + 1)); }
  }
  return null;
}
async function candidates(title) {
  const html = await req('https://www.themoviedb.org/search?query=' + encodeURIComponent(title) + '&language=ar');
  if (!html) return [];
  const ids = [];
  for (const m of html.matchAll(/\/(tv|movie)\/(\d+)/g)) {
    const key = m[1] + '/' + m[2];
    if (!ids.includes(key)) ids.push(key);
  }
  return ids.slice(0, 3);
}
function parsePage(html) {
  const genres = [...new Set([...html.matchAll(/href="\/genre\/\d+-[^"]*"[^>]*>\s*([^<]{2,40}?)\s*<\/a>/g)].map((m) => m[1]))];
  const t = (html.match(/<title>([^<]{0,120})/) || [])[1] || '';
  const name = t.replace(/\s*&#8212;.*$/, '').replace(/\s*[-–|].*$/, '').trim();
  const yearM = t.match(/\(([^)]*?)(\d{4})[^)]*\)/);
  return { genres, name, year: yearM ? parseInt(yearM[2], 10) : 0, titleRaw: t };
}
function toTags(genres) {
  const out = [];
  for (const g of genres) {
    const k = Object.keys(GENRE_MAP).find((x) => normTitle(g).includes(normTitle(x)));
    if (!k) continue;
    const tag = GENRE_MAP[k];
    if (tag && out.indexOf(tag) < 0) out.push(tag);
  }
  return out;
}
function score(p, title, year) {
  const na = normTitle(title).replace(/[^\p{L}\p{N} ]/gu, ' ').replace(/\s+/g, ' ').trim();
  const nb = normTitle(p.name).replace(/[^\p{L}\p{N} ]/gu, ' ').replace(/\s+/g, ' ').trim();
  if (!na || !nb) return -1;
  const ydiff = year && p.year ? Math.abs(year - p.year) : null;
  let sim = 0;
  if (na === nb) sim = 3;
  else if (na.includes(nb) || nb.includes(na)) sim = 2;
  else if (similarTitle(title, p.name)) sim = 1;
  // a much shorter TMDB name than ours is usually a different entry (e.g. franchise name)
  const lenRatio = nb.length / Math.max(na.length, 1);
  const lenPenalty = sim === 2 && lenRatio < 0.6 && (ydiff === null || ydiff > 1) ? 2 : 0;
  let score = sim * 10 - lenPenalty * 5;
  if (ydiff !== null) score += ydiff === 0 ? 6 : ydiff <= 1 ? 4 : ydiff <= 2 ? 1 : -6;
  score += Math.min((p.popularity || 0) / 500, 2);
  return score;
}
async function classify(title, year) {
  const ids = await candidates(title.replace(/[:：].*$/, '').trim() || title);
  const evals = [];
  for (const id of ids.slice(0, 3)) {
    const html = await req('https://www.themoviedb.org/' + id + '?language=ar');
    if (!html) continue;
    const p = parsePage(html);
    const sc = score(p, title, year);
    if (sc < 8) continue;                       // weak evidence: ignore
    const tags = toTags(p.genres);
    if (!tags.length) continue;
    evals.push({ sc, tags, match: p.name, tmdb: id, year: p.year,
      conf: sc >= 18 ? 'high' : sc >= 12 ? 'medium' : 'low' });
  }
  evals.sort((a, b) => b.sc - a.sc);
  return evals[0] || null;
}
async function pool(items, worker, conc) {
  let i = 0;
  await Promise.all(Array.from({ length: conc }, async () => { while (i < items.length) { const k = i++; await worker(items[k]); } }));
}

(async () => {
  const n = parseInt(process.argv[2] || '800', 10);
  const idx = JSON.parse(fs.readFileSync(path.join(__dirname, 'catalog-index.min.json'), 'utf8'));
  const all = [];
  for (const sec of ['series', 'movies']) for (const it of idx[sec].items) all.push({ slug: it[0], title: it[1], year: parseInt(it[3], 10) || 0 });
  const s = load();
  const todo = all.filter((x) => !s.tried[x.slug])
    .sort((a, b) => (isArabic(b.title) ? 1 : 0) - (isArabic(a.title) ? 1 : 0))
    .slice(0, n);
  if (!todo.length) { console.log('nothing left'); return; }
  console.log(`tmdb pass: ${todo.length} titles (tried so far: ${Object.keys(s.tried).length}/${all.length})`);
  let done = 0, matched = 0;
  const t0 = Date.now();
  await pool(todo, async (x) => {
    try {
      const r = await classify(x.title, x.year);
      if (r) { s.results[x.slug] = { tags: r.tags, source: 'tmdb', match: r.match, conf: r.conf, tmdb: r.tmdb }; matched++; }
      s.tried[x.slug] = 1;
    } catch (e) { /* leave for a later pass */ }
    done++;
    if (done % 25 === 0) {
      save(s);
      const rate = done / ((Date.now() - t0) / 1000);
      process.stdout.write(`\r  ${done}/${todo.length} | matched ${matched} (${((matched / done) * 100).toFixed(0)}%) | ${rate.toFixed(1)}/s | eta ${Math.round((todo.length - done) / Math.max(rate, 0.1) / 60)}m   `);
    }
  }, CONC);
  save(s);
  console.log(`\n  chunk done: ${matched}/${todo.length} matched from TMDB in ${((Date.now() - t0) / 60000).toFixed(1)} min`);
  const conf = {}; for (const v of Object.values(s.results)) conf[v.conf] = (conf[v.conf] || 0) + 1;
  console.log('  total tmdb results so far:', Object.keys(s.results).length, JSON.stringify(conf));
})().catch((e) => { console.error('ERR', e.stack || e.message); process.exit(1); });
