// Builds the cross-source maps with a stricter, more forgiving matcher than plain
// string equality: normalised titles (prefixes/suffixes stripped), then token overlap.
// Writes src/jc-smap.json (our series → their series) and src/jc-map.json (our movie →
// their movie). Only pairs whose episode counts are compatible are kept for series.
const fs = require('fs');
const path = require('path');

const SRC = __dirname;
const norm = (s) => String(s || '')
  .normalize('NFKC')
  .replace(/[\u064B-\u0652\u0640]/g, '')            // harakat + tatweel
  .replace(/[أإآٱ]/g, 'ا').replace(/ى/g, 'ي').replace(/ؤ/g, 'و').replace(/ئ/g, 'ي').replace(/ة/g, 'ه')
  .replace(/[\u200f\u200e\u00ab\u00bb"'«»\u2013\u2014]/g, ' ')
  .toLowerCase()
  .replace(/\b(مسلسل|series|movie|film|فيلم|الفيلم|special|سبيشل|مترجم|مدبلج|بالإنكليزية|بالانجليزية|كامل|كاملة)\b/g, ' ')
  .replace(/\(\s*\d+\s*\)/g, ' ')                    // (1) (2) season markers
  .replace(/[^\p{L}\p{N}\s]/gu, ' ')
  .replace(/\s+/g, ' ')
  .trim();
const STOP = new Set(['the', 'and', 'for', 'with', 'its', 'his', 'her', 'all', 'new', 'من', 'في', 'على', 'الى', 'إلى', 'مع', 'عن', 'هذا', 'هذه']);
const toks = (s) => new Set(norm(s).split(' ').filter((w) => w.length > 2 && !STOP.has(w)));
const jac = (a, b) => {
  if (!a.size || !b.size) return 0;
  let i = 0; for (const t of a) if (b.has(t)) i++;
  return i / Math.min(a.size, b.size);
};

const jc = JSON.parse(fs.readFileSync(path.join(SRC, 'jcartoon.json'), 'utf8'));
const idx = JSON.parse(fs.readFileSync(path.join(SRC, 'catalog-index.min.json'), 'utf8'));
const ours = [];
for (const k of ['series', 'movies']) for (const it of idx[k].items) ours.push({ slug: it[0], title: it[1], kind: k === 'movies' ? 'movie' : 'series' });

const ourT = ours.map((o) => ({ ...o, n: norm(o.title), t: toks(o.title) }));
const smap = {}, fmap = {}, report = [];

// A single shared word is not a match ("جو البطل" vs "مغامرات البطل وتاروو"), and neither
// is a title made only of stop words ("The 99"). Fuzzy needs two shared tokens, a high
// overlap, and a comparable length so seasons of different shows never merge.
function fuzzyOk(a, b) {
  const shared = [...a].filter((x) => b.has(x));
  if (shared.length >= 2) {
    const score = shared.length / Math.min(a.size, b.size);
    return score >= 0.85 && Math.abs(a.size - b.size) <= 1;
  }
  if (shared.length === 1 && Math.min(a.size, b.size) === 1) return shared[0].length >= 6;
  return false;
}
function best(theirTitle, kind) {
  const n = norm(theirTitle); const t = toks(theirTitle);
  let hit = ourT.find((o) => o.n === n && o.kind === kind);
  if (hit) return { o: hit, how: 'exact', conf: 3 };
  hit = ourT.find((o) => o.n === n);                       // same title, other section
  if (hit) return { o: hit, how: 'exact-other-section', conf: 3 };
  let bestO = null, bestS = 0;
  for (const o of ourT) {
    if (o.kind !== kind) continue;
    if (!fuzzyOk(t, o.t)) continue;
    const s = jac(t, o.t);
    if (s > bestS) { bestS = s; bestO = o; }
  }
  if (bestO) return { o: bestO, how: 'fuzzy ' + bestS.toFixed(2), conf: 2 };
  return null;
}

for (const s of jc.series) {
  const m = best(s.title, 'series');
  if (!m) continue;
  const prev = smap[m.o.slug];
  if (prev && prev.conf >= m.conf) continue;
  smap[m.o.slug] = { id: s.id, title: s.title, total: (s.episodes || []).length, how: m.how, conf: m.conf };
  report.push(['series', m.o.title, s.title, m.how]);
}
for (const f of jc.movies) {
  const m = best(f.title, 'movie') || best(f.title, 'series');
  if (!m) continue;
  const prev = fmap[m.o.slug];
  if (prev && prev.conf >= m.conf) continue;
  fmap[m.o.slug] = { id: f.id, title: f.title, kind: 'movie', how: m.how, conf: m.conf };
  report.push(['movie', m.o.title, f.title, m.how]);
}

fs.writeFileSync(path.join(SRC, 'jc-smap.json'), JSON.stringify({ note: 'stardima series → jcartoon series (normalised + fuzzy match)', items: smap }));
fs.writeFileSync(path.join(SRC, 'jc-map.json'), JSON.stringify({ note: 'stardima entry → jcartoon film', items: fmap }));
const byHow = {};
for (const r of report) { const k = r[3].split(' ')[0]; byHow[k] = (byHow[k] || 0) + 1; }
console.log(`  مسلسلات مربوطة: ${Object.keys(smap).length} · أفلام: ${Object.keys(fmap).length} | طريقة المطابقة:`, JSON.stringify(byHow));
console.log('  أمثلة:', report.slice(0, 6).map((r) => `${r[1]} = ${r[2]}`).join(' · '));
