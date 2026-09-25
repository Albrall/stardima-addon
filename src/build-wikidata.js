// Bulk Wikidata label join: 50 Arabic titles per SPARQL query, filtered to item
// types that are actually works (TV series / anime / film / animated series) so
// homonyms like القناص -> 'Shooter' cannot slip through. Also pulls P136 genres.
const fs = require('fs');
const path = require('path');
const { normTitle } = require('./lib/stardima');
const OUT = path.join(__dirname, 'wd-matches.json');
const UA = 'stardima-addon/1.0 (metadata; contact none)';
const BATCH = 45;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const WORK_TYPES = ['Q5398426', 'Q1107', 'Q11424', 'Q581714', 'Q8274', 'Q202866', 'Q15416', 'Q63952888', 'Q93204', 'Q24856', 'Q506240', 'Q1259759', 'Q196600'];
const GENRE_RULES = [
  [/أكشن|اكشن|قتال|action/, 'أكشن'], [/مغامر|adventure/, 'مغامرة'], [/كوميد|comedy/, 'كوميدي'],
  [/درام|drama/, 'دراما'], [/فانتاز|فنتاز|fantasy/, 'فانتازيا'], [/خيال علمي|science fiction|sci-fi/, 'خيال علمي'],
  [/رعب|horror/, 'رعب'], [/غموض|جريم|محقق|إثارة|اثارة|mystery|crime|بوليسي/, 'غموض وتحقيق'],
  [/رياض|sport/, 'رياضة'], [/موسيق|music/, 'موسيقي'], [/رومانس|رومنس|romance/, 'رومانسي'],
  [/تاريخ|historical/, 'تاريخي'], [/سحر|magic/, 'بنات السحر'], [/طبخ|cooking/, 'طبخ'],
  [/روبوت|ميكا|robot|mecha/, 'روبوتات'], [/فضاء|فضائي|space/, 'فضاء'], [/قراصن|pirate/, 'قراصنة'],
  [/نينج|ساموراي|ninja|samurai/, 'نينجا وساموراي'], [/حيوان|animal/, 'حيوانات'], [/مدرس|school/, 'مدرسي'],
  [/فنون قتالية|martial/, 'أكشن'], [/خارق|supernatural|خارق للطبيعة/, 'فانتازيا'],
];
function toTags(labels) {
  const out = [];
  for (const raw of labels) {
    const n = normTitle(raw);
    for (const [re, tag] of GENRE_RULES) if (re.test(n) && !out.includes(tag)) out.push(tag);
  }
  return out;
}
async function sparql(query, tries = 4) {
  for (let a = 0; a < tries; a++) {
    try {
      const res = await fetch('https://query.wikidata.org/sparql', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/sparql-results+json', 'User-Agent': UA },
        body: 'query=' + encodeURIComponent(query),
      });
      if (res.status === 429 || res.status === 502) { await sleep(3000 * (a + 1)); continue; }
      if (!res.ok) { await sleep(1200); continue; }
      return await res.json();
    } catch (e) { await sleep(1200); }
  }
  return null;
}
function queryFor(titles) {
  const vals = titles.map((t) => `"${t.replace(/"/g, '')}"@ar`).join(' ');
  const types = WORK_TYPES.map((q) => `wd:${q}`).join(' ');
  return `SELECT ?item ?arLabel ?enLabel (GROUP_CONCAT(DISTINCT ?gl; separator="|") AS ?genres) WHERE {
  VALUES ?arLabel { ${vals} }
  ?item rdfs:label ?arLabel .
  ?item wdt:P31 ?type . VALUES ?type { ${types} }
  OPTIONAL { ?item rdfs:label ?enLabel . FILTER(lang(?enLabel)="en") }
  OPTIONAL { ?item wdt:P136 ?g . ?g rdfs:label ?gl . FILTER(lang(?gl)="ar" || lang(?gl)="en") }
} GROUP BY ?item ?arLabel ?enLabel`;
}
(async () => {
  const cats = JSON.parse(fs.readFileSync(path.join(__dirname, 'catalog-index.min.json'), 'utf8'));
  const all = [];
  for (const sec of ['series', 'movies']) for (const it of cats[sec].items) if (/[\u0600-\u06FF]/.test(it[1])) all.push({ slug: it[0], title: it[1], year: parseInt(it[3], 10) || 0 });
  const results = {}; let done = 0, hits = 0;
  for (let i = 0; i < all.length; i += BATCH) {
    const b = all.slice(i, i + BATCH);
    const j = await sparql(queryFor(b.map((x) => x.title)));
    const rows = (j && j.results && j.results.bindings) || [];
    const byLabel = {};
    for (const r of rows) {
      const key = normTitle(r.arLabel.value);
      (byLabel[key] = byLabel[key] || []).push(r);
    }
    for (const x of b) {
      const rows2 = byLabel[normTitle(x.title)];
      if (!rows2 || !rows2.length) continue;
      // prefer rows whose English genre labels actually map to our tags
      let best = null;
      for (const r of rows2) {
        const gl = (r.genres ? r.genres.value : '').split('|').filter(Boolean);
        const tags = toTags(gl);
        if (!tags.length) continue;
        if (!best || tags.length > best.tags.length) best = { tags, en: r.enLabel ? r.enLabel.value : '' };
      }
      if (!best) continue;
      results[x.slug] = { tags: best.tags, source: 'wikidata-join', match: best.en || x.title, conf: 'medium' };
      hits++;
    }
    done += b.length;
    if (i % (BATCH * 6) === 0) { fs.writeFileSync(OUT, JSON.stringify({ results, built: new Date().toISOString() })); process.stdout.write(`\r  wikidata: ${done}/${all.length} scanned | ${hits} tagged   `); }
    await sleep(700);
  }
  fs.writeFileSync(OUT, JSON.stringify({ results, built: new Date().toISOString() }));
  console.log(`\n  wikidata bulk done: ${hits} tagged of ${all.length} Arabic titles (${((hits / all.length) * 100).toFixed(0)}%)`);
  const nameOf = {}; for (const sec of ['series', 'movies']) for (const it of cats[sec].items) nameOf[it[0]] = it[1];
  console.log('--- samples ---');
  Object.keys(results).filter((_, i) => i % Math.max(1, Math.floor(Object.keys(results).length / 14)) === 0).slice(0, 14)
    .forEach((s) => console.log(`  ${(nameOf[s] || s).slice(0, 28).padEnd(30)} -> ${results[s].match.slice(0, 28).padEnd(30)} | ${results[s].tags.join(', ')}`));
})().catch((e) => { console.error('ERR', e.stack || e.message); process.exit(1); });
