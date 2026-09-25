// Merges every source into our-genres.json, highest trust first:
//   TMDB (real genres, Arabic) > AniList > Wikidata > our heuristics
const fs = require('fs');
const path = require('path');
const base = JSON.parse(fs.readFileSync(path.join(__dirname, 'our-genres.json'), 'utf8'));
const labels = base.labels;
const heuristic = JSON.parse(fs.readFileSync(path.join(__dirname, 'our-genres-heuristic.json'), 'utf8'));
const read = (f) => { try { return JSON.parse(fs.readFileSync(path.join(__dirname, f), 'utf8')).results || {}; } catch (e) { return {}; } };
const tmdb = read('meta-tmdb-state.json');
const meta = read('meta-state.json');
const idx = JSON.parse(fs.readFileSync(path.join(__dirname, 'catalog-index.min.json'), 'utf8'));

const items = {}, source = {}, match = {}, confidence = {};
const all = [];
for (const sec of ['series', 'movies']) for (const it of idx[sec].items) all.push(it[0]);
const order = ['tmdb', 'anilist(ar)', 'anilist(en)', 'wikidata'];
for (const slug of all) {
  const cand = [];
  if (tmdb[slug]) cand.push(tmdb[slug]);
  if (meta[slug]) cand.push(meta[slug]);
  let pick = cand.sort((a, b) => order.indexOf(a.source) - order.indexOf(b.source))[0];
  let tags = pick ? pick.tags.slice() : [];
  let src = pick ? pick.source : '';
  if (!tags.length) {
    const raw = heuristic.items[slug];
    if (raw) { tags = String(raw).split(',').map((n) => labels[+n]).filter(Boolean); src = 'heuristic'; }
  }
  if (!tags.length) continue;
  const idxs = [...new Set(tags.map((t) => labels.indexOf(t)).filter((i) => i >= 0))];
  if (!idxs.length) continue;
  items[slug] = idxs.join(',');
  source[slug] = src;
  if (pick) { match[slug] = pick.match || ''; confidence[slug] = pick.conf || ''; }
}
const out = { labels, items, source, match, confidence, built: new Date().toISOString(), via: 'merge' };
fs.writeFileSync(path.join(__dirname, 'our-genres.json'), JSON.stringify(out));

const bySrc = {}; for (const v of Object.values(source)) bySrc[v] = (bySrc[v] || 0) + 1;
const total = all.length;
console.log(`merged: ${Object.keys(items).length}/${total} tagged (${((Object.keys(items).length / total) * 100).toFixed(0)}%)`);
console.log('  by source:', JSON.stringify(bySrc));
// human review file
let md = '# مراجعة التصنيفات (من مصادر حقيقية)\n\n';
md += `> ${Object.keys(items).length} من ${total} عملًا مصنّف. الأولوية: TMDB (تصنيفات حقيقية بالعربي) ثم AniList ثم Wikidata، والتحليل الآلي فقط لما لا يوجد له مصدر.\n\n`;
md += '| المصدر | عدد | الجودة |\n|---|---|---|\n';
md += `| TMDB | ${bySrc.tmdb || 0} | تصنيفات رسمية |\n| AniList | ${(bySrc['anilist(ar)'] || 0) + (bySrc['anilist(en)'] || 0)} | تصنيفات رسمية |\n| Wikidata | ${bySrc.wikidata || 0} | تصنيفات رسمية |\n| تحليل آلي | ${bySrc.heuristic || 0} | تقريبي |\n\n`;
const nameOf = {}; for (const sec of ['series', 'movies']) for (const it of idx[sec].items) nameOf[it[0]] = it[1];
md += '## عيّنة من تصنيفات TMDB (للتحقق)\n\n| العمل | مطابقة TMDB | تصنيفاتنا |\n|---|---|---|\n';
for (const [slug, r] of Object.entries(tmdb).filter((_, i) => i % 23 === 0).slice(0, 40)) {
  md += `| ${nameOf[slug] || slug} | ${r.match} | ${r.tags.join(' · ')} |\n`;
}
fs.writeFileSync('/home/user/التصنيفات-مراجعة.md', md);
console.log('  review file written');
