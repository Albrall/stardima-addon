// Groups duplicate uploads ("versions") of the same work into one entry.
//  1. walks the site's language filter (dub/sub) -> knows which upload is dubbed
//     and which is subbed
//  2. groups titles with the same name + year whose descriptions match
//     (identical re-uploads like the 4x "أليس في بلاد العجائب"), and keeps
//     genuinely different works apart ("السنافر" 1981 vs 2021 vs two films)
//  3. for series it maps episodes across versions by (season, episode)
// Output: families.json
const fs = require('fs');
const path = require('path');
const { getJson, BASE, normTitle, getSeriesMeta } = require('./lib/stardima');

const OUT = path.join(__dirname, 'families.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CONC = 6;

async function page(ep, p, extra) {
  const url = `${BASE}/${ep}?page=${p}${extra || ''}`;
  for (let a = 0; a < 4; a++) { try { return await getJson(url); } catch (e) { await sleep(500 * (a + 1)); } }
  return null;
}
async function pool(items, worker, conc) {
  let i = 0;
  await Promise.all(Array.from({ length: conc }, async () => { while (i < items.length) await worker(items[i++]); }));
}
function slugOf(url) { const p = String(url || '').split('/').filter(Boolean); return p[p.length - 1] || ''; }

// ---------- 1) language map ----------
async function languageMap() {
  const lang = {};
  for (const [ep, kind] of [['mosalsalat', 'series'], ['aflam', 'movies']]) {
    for (const [q, label] of [['&language=dub', 'dub'], ['&language=sub', 'sub']]) {
      const first = await page(ep, 1, q);
      const last = ((first && first.pagination && first.pagination.last_page) || 0);
      const pages = Array.from({ length: last }, (_, i) => i + 1);
      let n = 0;
      await pool(pages, async (p) => {
        const j = p === 1 ? first : await page(ep, p, q);
        for (const v of ((j && j.videos) || [])) { const s = slugOf(v.url); if (s) { lang[s] = label; n++; } }
      }, CONC);
      console.log(`  language ${label} (${kind}): ${last} pages, ${n} titles`);
    }
  }
  return lang;
}

// ---------- 2) duplicate detection ----------
const MARKERS = [
  [/مصري(?:ة|ه)?/, '🇪🇬 مصري'],
  [/فصحى/, '🇸🇦 فصيح'],
  [/بدون حذف|بدون حجب|غير محذوف/, 'F كاملة'],
  [/كامل(?:ة|ه)?(?:\s|$)/, 'F كاملة'],
  [/النسخة الأولى|النسخة الاولى/, 'نسخة 1'],
  [/النسخة الثانية/, 'نسخة 2'],
  [/النسخة الثالثة/, 'نسخة 3'],
  [/النسخة الرابعة/, 'نسخة 4'],
];
function normTitleKey(t) {
  return normTitle(String(t).replace(/[\(\)\[\]«»"'،,:؛!؟.\-–—]/g, ' ')).replace(/\s+/g, ' ').trim();
}
function descTokens(d) {
  return new Set(normTitle(d || '').replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter((t) => t.length >= 3));
}
function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0; for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}
let POSTER_LABELS = {};
try {
  POSTER_LABELS = JSON.parse(fs.readFileSync(path.join(__dirname, 'poster-labels.json'), 'utf8')).labels || {};
} catch (e) { POSTER_LABELS = {}; }
const DUB_LABEL = { fusha: '🇸🇦 فصحى', masri: '🇪🇬 مصري', arabi: '🇸🇦 مدبلج' };

function labelFor(slug, title, lang) {
  const parts = [];
  for (const [re, label] of MARKERS) if (re.test(title)) parts.push(label);
  // The poster the site uploads often says which dub it is (فصحى / مصري) — that beats guessing.
  const pl = POSTER_LABELS[slug];
  if (pl && DUB_LABEL[pl.dub] && !parts.some((p) => /فصحى|مصري|مدبلج/.test(p))) parts.push(DUB_LABEL[pl.dub]);
  const l = lang[slug];
  if (l === 'sub' && !parts.some((p) => /مترجم|فصيح|مصري/.test(p))) parts.push('E مترجم');
  else if (l === 'dub' && !parts.some((p) => /مدبلج|فصيح|مصري|كاملة/.test(p))) {
    parts.push(pl && DUB_LABEL[pl.dub] ? DUB_LABEL[pl.dub] : '🇸🇦 مدبلج');
  }
  if (!parts.length) parts.push('نسخة');
  return [...new Set(parts)].join(' · ');
}

(async () => {
  const titles = JSON.parse(fs.readFileSync(path.join(__dirname, 'titles.json'), 'utf8'));
  const cat = JSON.parse(fs.readFileSync(path.join(__dirname, 'catalog-index.min.json'), 'utf8'));
  const rows = [];
  for (const sec of ['series', 'movies']) for (const it of cat[sec].items) {
    rows.push({ slug: it[0], title: it[1], year: parseInt(it[3], 10) || 0, sec, d: (titles[it[0]] || {}).d || '' });
  }
  console.log(`scanning ${rows.length} titles for duplicate uploads`);
  console.log('walking the language filter...');
  const lang = await languageMap();
  fs.writeFileSync(path.join(__dirname, 'lang-map.json'), JSON.stringify(lang));
  console.log(`  language known for ${Object.keys(lang).length} titles`);

  // group by normalised title + year, then split by description similarity
  const buckets = {};
  for (const r of rows) {
    const k = normTitleKey(r.title) + '|' + (r.year || '');
    (buckets[k] = buckets[k] || []).push(r);
  }
  const groups = [];
  for (const k of Object.keys(buckets)) {
    const list = buckets[k];
    if (list.length < 2) continue;
    const used = new Set();
    for (const r of list) {
      if (used.has(r.slug)) continue;
      const fam = [r]; used.add(r.slug);
      const t1 = descTokens(r.d);
      for (const o of list) {
        if (used.has(o.slug) || o.sec !== r.sec) continue;
        // Exact title + year + section is already strong evidence of a re-upload:
        // some uploaders write their own blurb, so description similarity alone
        // missed cases like "الأسد الملك (1994)" twice with two different texts.
        // Year difference is what keeps genuinely different works apart
        // (السنافر 1981 series vs 2011/2025 films), and that is handled by the bucket key.
        const descSame = (r.d && o.d && normTitle(r.d).slice(0, 90) === normTitle(o.d).slice(0, 90)) || jaccard(t1, descTokens(o.d)) >= 0.75;
        const same = descSame || true;
        if (same) { fam.push(o); used.add(o.slug); }
      }
      if (fam.length > 1) groups.push({ sec: r.sec, title: r.title, year: r.year, members: fam });
    }
  }
  console.log(`duplicate families found: ${groups.length} (covering ${groups.reduce((s, g) => s + g.members.length, 0)} entries)`);

  const memberOf = {}, families = {};
  for (const g of groups) {
    const scored = g.members.map((m) => ({ m, lang: lang[m.slug] || '' }));
    scored.sort((a, b) => (a.lang === 'dub' ? -1 : 0) - (b.lang === 'dub' ? -1 : 0));
    const primary = scored[0].m;
    const seenLabel = new Map();
    const members = scored.map(({ m }) => {
      let label = labelFor(m.slug, m.title, lang);
      const n = (seenLabel.get(label) || 0) + 1;   // identical uploads: same version, marked as extra copy
      seenLabel.set(label, n);
      if (n > 1) label = (label ? label + ' · ' : '') + 'نسخة ' + n;
      return { slug: m.slug, label, year: m.year };
    });
    families[primary.slug] = { sec: g.sec, title: g.title, year: g.year, members };
    for (const m of g.members) memberOf[m.slug] = primary.slug;
  }

  // episode mapping for series families (same episode in each edition)
  const seriesFams = Object.keys(families).filter((p) => families[p].sec === 'series');
  console.log(`building episode maps for ${seriesFams.length} series families...`);
  const epMaps = {};
  let done = 0;
  await pool(seriesFams, async (primary) => {
    const f = families[primary];
    const map = {};
    for (const m of f.members) {
      try {
        const mm = await getSeriesMeta(m.slug);
        for (const v of (mm.videos || [])) {
          const key = (v.season || 1) + ':' + (v.episode || 1);
          (map[key] = map[key] || []).push([m.slug, v.episodeId]);
        }
      } catch (e) { /* skip member */ }
    }
    if (Object.keys(map).length) epMaps[primary] = map;
    if (++done % 5 === 0) process.stdout.write(`\r  episode maps: ${done}/${seriesFams.length}   `);
  }, 3);
  console.log(`\n  episode maps built: ${Object.keys(epMaps).length}`);

  const out = { families, memberOf, epMap: epMaps, lang, built: new Date().toISOString() };
  fs.writeFileSync(OUT, JSON.stringify(out));
  console.log(`families.json written (${(fs.statSync(OUT).size / 1024).toFixed(0)} KB)`);
  console.log('\n--- samples ---');
  Object.entries(families).slice(0, 10).forEach(([p, f]) => {
    console.log(`  ${f.title.slice(0, 28)} [${f.sec}] -> ${f.members.map((m) => m.slug.slice(0, 14) + ' (' + m.label + ')').join(' | ')}`);
  });
})().catch((e) => { console.error('ERR', e.stack || e.message); process.exit(1); });
