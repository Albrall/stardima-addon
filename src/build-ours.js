// Derives OUR OWN genre tags for the whole library, on top of the site's
// categories. Signals: Arabic title, Arabic synopsis, release year and the
// site's own category membership. Output: our-genres.json (slug -> tag indices)
// plus a quality report printed to stdout.
const fs = require('fs');
const path = require('path');
const { getJson, BASE, normTitle } = require('./lib/stardima');

const CONC = 4;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- lexicon: genre -> [keyword, weight] (keywords are normalised at load) ----
const LEX = {
  'أكشن': [['معرك*',3],['قتال*',3],['مواجه*',3],['شرير',2],['أشرار',2],['ينقذ',2],['انتقام',2],['قوى خارقه',2],['خارق*',2],['بطل خارق',3],['يتصدون',2],['يصارع*',3],['عصابه',1],['تدريب قتالي',2],['حرب',1],['الاعداء',2],['ينتقم',2]],
  'مغامرة': [['مغامر*',3],['رحل*',2],['جزير*',2],['كنز',2],['كنوز',2],['استكشاف',2],['يكتشف*',2],['عالم جديد',2],['يبحرون',2],['رحلة بحث',2]],
  'كوميدي': [['كوميد*',3],['مضحك*',3],['فكاهي*',3],['ضحك*',2],['مقالب',3],['ساخر*',2],['طريف*',2]],
  'دراما': [['درام*',3],['عائل*',2],['صداق*',2],['مؤثر*',3],['مشاعر',2],['فقد',2],['تحديات الحياه',2],['تربيه',1]],
  'خيال علمي': [['خيال علمي',3],['شاكرا',2],['تشاكرا',2],['تكنولوجيا',2],['مستقبل',2],['مختبر',2],['مجرات',2],['كائنات فضائيه',3],['ذكاء اصطناعي',3],['تجارب علميه',2],['علماء',2]],
  'فانتازيا': [['سحر*',2],['ساحر*',2],['اسطور*',2],['تنين*',2],['مملك*',2],['تعويذه',2],['فانتازيا',3],['قدرات خاصه',2],['عالم سحري',3],['مخلوقات اسطوريه',3],['جني',2]],
  'غموض وتحقيق': [['غموض*',3],['غامض*',3],['تحقيق*',2],['محقق*',3],['جريم*',2],['اختطف*',2],['اسرار',2],['لغز*',3],['قتل',2]],
  'رعب': [['رعب*',3],['مرعب*',3],['مخيف*',2],['اشباح',3],['شبح*',3],['زومبي',3],['وحش*',1],['ظلام دامس',2]],
  'رياضة': [['كره القدم',3],['كره السله',3],['مباراه',2],['مباريات',2],['بطول*',2],['مدرب',2],['لاعب*',2],['دوري',2],['رياض*',3],['سباق*',2],['تسابق',3],['فريق كره',3]],
  'مدرسي': [['مدرس*',3],['طلاب',2],['تلاميذ',2],['فصل دراسي',2],['معلم*',2],['زملاء',2],['حصة دراسيه',2]],
  'موسيقي': [['موسيق*',3],['اغنيه',3],['اغنية',3],['اغاني',3],['غناء',2],['يغني',2],['يغنون',2],['فرقه موسيقيه',3],['اوركسترا',2],['الروك',2]],
  'طبخ': [['طبخ*',3],['طباخ*',3],['مطبخ*',3],['مطعم*',3],['شيف',3],['وصفات',3],['حلوى',2],['مخبوزات',2],['وجبات',2]],
  'حيوانات': [['حيوان*',3],['قطط',2],['قطه',2],['كلب',2],['كلاب',2],['اسد',2],['ديناصور*',3],['ارنب*',2],['دب',2],['طيور',2],['طائر',2],['قرد*',2],['قرش*',2],['حديقه الحيوان',3]],
  'فضاء': [['فضاء',3],['فضائي*',3],['كواكب',3],['صاروخ*',2],['مجره',2],['رائد فضاء',3]],
  'روبوتات': [['روبوت*',3],['ميكا',3],['رجل الي',3],['سايبورغ',3],['مركبات عملاقه',3]],
  'قراصنة': [['قراصن*',3],['قرصان*',3],['كنز مدفون',3],['سفينه شراعيه',2]],
  'نينجا وساموراي': [['نينج*',3],['ساموراي*',3],['شينوبي',3],['كونوها',3],['هوكاج*',3],['سيوف',2],['سيف',1],['محارب',1]],
  'سيارات': [['سيار*',3],['سائق',2],['شاحنات',2],['محرك',1],['سباق سيارات',3]],
  'ديني وإسلامي': [['اسلام*',3],['انبياء',3],['نبي',2],['صحاب*',3],['قران',3],['ديني',3],['القيم الاسلاميه',3],['غزوه',3],['السيره النبويه',3]],
  'رومانسي': [['رومانسي*',3],['قصه حب',3],['وقعت في حب',3],['زواج',2],['خطوبه',2],['حب',1]],
  'تاريخي': [['تاريخ*',3],['فرعون*',3],['مصر القديمه',3],['الحرب العالميه',3],['امبراطور*',3],['العصور الوسطى',3],['حضاره',3],['روما',2],['قديم*',1]],
  'بنات السحر': [['ساحرات',3],['ساحره',3],['فتيات السحر',3],['بنات السحر',3],['ماجيكال*',2],['تحول سحري',2],['قوى السحر',3],['فتاه سحريه',3]],
};
const YEAR_TAGS = [
  { label: 'كلاسيكي (قبل 2000)', test: (y) => y && y < 2000 },
  { label: 'جديد (2020+)', test: (y) => y && y >= 2020 },
];

// site category -> our genre boost
const SITE_BOOST = {
  // collections the site curates by hand — reliable, so they seed our genres
  'aflam-konan': [['غموض وتحقيق', 4]],
  'aflam-naorto': [['أكشن', 3], ['نينجا وساموراي', 4]],
  'aflam-doraymon-doraemon-movie': [['خيال علمي', 4], ['فانتازيا', 3]],
  'aflam-harry-potter': [['فانتازيا', 4]],
  'aflam-boku-no-hero-academia': [['أكشن', 3]],
  'aflam-skoby-do-scooby-doo': [['غموض وتحقيق', 3], ['رعب', 2]],
  'akshn': [['أكشن', 3]],
  'mghamrat': [['مغامرة', 4]],
  'okt-almghamr': [['مغامرة', 4]],
  'nynga': [['نينجا وساموراي', 4]],
  'krton-aslamy': [['ديني وإسلامي', 4]],
  'sbys-baor': [['خيال علمي', 2], ['فضاء', 2]],
  'barby': [['رومانسي', 2]],
  'aflam-barby': [['فانتازيا', 2], ['رومانسي', 2]],
  'aflam-gyym-jeem': [],
  'krton-ntork': [],
};

const LABELS = Object.keys(LEX);
const YEAR_LABELS = YEAR_TAGS.map((t) => t.label);
const ALL_LABELS = [...LABELS, ...YEAR_LABELS];
const NORM_LEX = Object.entries(LEX).map(([label, kws]) => [label, kws.map(([k, w]) => [normTitle(k), w])]);

// Normalised text padded with spaces so substring scans become exact token /
// phrase matches (Arabic has no \b, and short words like 'دب' would otherwise
// match inside 'أدب').
function pad(text) { return ' ' + String(text).replace(/\s+/g, ' ').trim() + ' '; }
function hasPhrase(padded, kw) {
  if (!kw) return false;
  // Arabic definiteness: the site writes 'الشينوبي' where our lexicon says
  // 'شينوبي', so every keyword is also tried with the definite article.
  const variants = [kw];
  if (kw.endsWith('*')) variants.push('ال' + kw);
  else if (!kw.startsWith('ال')) variants.push('ال' + kw);
  for (const v of variants) {
    if (v.endsWith('*')) {
      const stem = v.slice(0, -1).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (new RegExp(' ' + stem + '[^ ]* ').test(padded)) return true;
    } else if (padded.indexOf(' ' + v + ' ') >= 0) return true;
  }
  return false;
}

async function page(ep, p) {
  for (let a = 0; a < 4; a++) {
    try { return await getJson(`${BASE}/${ep}?page=${p}`); } catch (e) { await sleep(600 * (a + 1)); }
  }
  return null;
}
async function pool(items, worker, conc) {
  let i = 0;
  await Promise.all(Array.from({ length: conc }, async () => {
    while (i < items.length) { const k = i++; await worker(items[k]); }
  }));
}

(async () => {
  const t0 = Date.now();
  const rows = [];
  for (const [ep, sec] of [['mosalsalat', 'series'], ['aflam', 'movies']]) {
    const first = await page(ep, 1);
    const last = Math.min((first && first.pagination && first.pagination.last_page) || 1, 200);
    const pages = Array.from({ length: last }, (_, i) => i + 1);
    await pool(pages, async (p) => {
      const j = p === 1 ? first : await page(ep, p);
      for (const v of ((j && j.videos) || [])) {
        const slug = String(v.url || '').split('/').filter(Boolean).pop();
        if (!slug) continue;
        rows.push({ slug, sec, title: v.title || '', desc: v.description || '', year: parseInt(v.year, 10) || 0 });
      }
    }, CONC);
    console.log(`  ${sec}: ${last} pages fetched`);
  }
  console.log('  titles collected:', rows.length);

  // site categories (built earlier by build-genres.js)
  let site = { labels: [], items: {} };
  try { site = JSON.parse(fs.readFileSync(path.join(__dirname, 'genres.json'), 'utf8')); } catch (e) {}
  const catsOf = (slug) => {
    const raw = site.items[slug];
    return raw ? String(raw).split(',').map((n) => (site.labels[+n] || [])[0]).filter(Boolean) : [];
  };

  const items = {};
  const stats = {}; LABELS.forEach((l) => (stats[l] = 0));
  for (const r of rows) {
    const title = pad(normTitle(r.title));
    const desc = pad(normTitle(r.desc));
    const scores = {};
    for (const [label, kws] of NORM_LEX) {
      let s = 0;
      for (const [k, w] of kws) {
        if (!k) continue;
        if (hasPhrase(title, k)) s += w * 2;
        else if (hasPhrase(desc, k)) s += w;
      }
      if (s) scores[label] = (scores[label] || 0) + s;
    }
    for (const c of catsOf(r.slug)) for (const [g, w] of (SITE_BOOST[c] || [])) scores[g] = (scores[g] || 0) + w;
    const BROAD = { 'مغامرة': 5, 'دراما': 4, 'مدرسي': 4, 'حيوانات': 4, 'رعب': 4, 'تاريخي': 4, 'رياضة': 4, 'فضاء': 5 };
    const picked = Object.entries(scores)
      .filter(([g, sc]) => sc >= (BROAD[g] || 3))
      .sort((a, b) => b[1] - a[1]).slice(0, 3).map(([g]) => g);
    for (const t of YEAR_TAGS) if (t.test(r.year)) picked.push(t.label);
    if (!picked.length) continue;
    const idx = picked.map((g) => ALL_LABELS.indexOf(g)).filter((i) => i >= 0);
    items[r.slug] = idx.join(',');
    picked.forEach((g) => { if (stats[g] !== undefined) stats[g]++; });
  }

  const out = { labels: ALL_LABELS, items, stats, built: new Date().toISOString() };
  fs.writeFileSync(path.join(__dirname, 'our-genres.json'), JSON.stringify(out));
  const tagged = Object.keys(items).length;
  console.log(`  tagged ${tagged}/${rows.length} titles (${((tagged / rows.length) * 100).toFixed(0)}%) in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  console.log('  per genre:', Object.entries(stats).sort((a, b) => b[1] - a[1]).map(([k, v]) => k + ':' + v).join(' · '));

  // ---- quality report: samples per genre ----
  const bySlug = new Map(rows.map((r) => [r.slug, r]));
  const report = [];
  for (const label of ALL_LABELS) {
    const gi = ALL_LABELS.indexOf(label);
    const hits = Object.entries(items).filter(([, v]) => v.split(',').includes(String(gi))).map(([s]) => s);
    if (!hits.length) continue;
    const sample = hits.filter((_, i) => i % Math.ceil(hits.length / 6) === 0).slice(0, 6).map((s) => (bySlug.get(s) || {}).title || s);
    report.push(`${label} (${hits.length}): ${sample.join(' | ')}`);
  }
  fs.writeFileSync(path.join(__dirname, 'our-genres-report.txt'), report.join('\n'));
  console.log('\n--- sample per genre ---');
  report.forEach((l) => console.log('  ' + l));
  // ---- validation: overlap with the site's own related categories ----
  const PAIRS = [['نينجا وساموراي','nynga'],['أكشن','akshn'],['ديني وإسلامي','krton-aslamy'],['مغامرة','mghamrat']];
  console.log("\n--- overlap with site categories ---");
  for (const [ours, siteSlug] of PAIRS) {
    const gi = ALL_LABELS.indexOf(ours);
    const oursSet = new Set(Object.entries(items).filter(([, v]) => v.split(',').includes(String(gi))).map(([k]) => k));
    const theirs = new Set(Object.entries(site.items).filter(([, v]) => v.split(',').includes(String(site.labels.findIndex(([sl]) => sl === siteSlug)))).map(([k]) => k));
    if (!theirs.size || !oursSet.size) { console.log(`  ${ours} vs ${siteSlug}: no data`); continue; }
    let inter = 0; for (const k of oursSet) if (theirs.has(k)) inter++;
    console.log(`  ${ours} (${oursSet.size}) vs ${siteSlug} (${theirs.size}): overlap ${inter} = ${((inter / Math.min(oursSet.size, theirs.size)) * 100).toFixed(0)}% of the smaller set`);
  }
  const untagged = rows.filter((r) => !items[r.slug]).slice(0, 12).map((r) => r.title);
  console.log('\n--- no tag yet (example) ---\n  ' + untagged.join(' | '));
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
