// Classifies the library from real metadata: AniList (Arabic query -> English via
// Wikipedia -> Wikidata genres), with strict anti-mismatch guards, chunked and
// resumable so it can run in several passes.
//   node build-meta.js 1200     -> process the next 1200 unprocessed titles
//   node build-meta.js final    -> assemble our-genres.json + print the report
const fs = require('fs');
const path = require('path');
const { normTitle } = require('./lib/stardima');

const STATE = path.join(__dirname, 'meta-state.json');
const CONC_WIKI = 8, CONC_AL = 3, BATCH = 20;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ANILIST_GENRES = {
  Action: 'أكشن', Adventure: 'مغامرة', Comedy: 'كوميدي', Drama: 'دراما', Fantasy: 'فانتازيا',
  Horror: 'رعب', 'Mahou Shoujo': 'بنات السحر', Mecha: 'روبوتات', Music: 'موسيقي',
  Mystery: 'غموض وتحقيق', Romance: 'رومانسي', 'Sci-Fi': 'خيال علمي', 'Slice of Life': 'دراما',
  Sports: 'رياضة', Supernatural: 'فانتازيا', Thriller: 'غموض وتحقيق', Psychological: 'غموض وتحقيق',
};
const ANILIST_TAGS = {
  Ninja: 'نينجا وساموراي', Samurai: 'نينجا وساموراي', Pirates: 'قراصنة', Cooking: 'طبخ',
  School: 'مدرسي', Historical: 'تاريخي', Space: 'فضاء', 'Outer Space': 'فضاء', Robot: 'روبوتات',
  Racing: 'سيارات', Cars: 'سيارات', Motorcycles: 'سيارات', Music: 'موسيقي', Idol: 'موسيقي',
  Detective: 'غموض وتحقيق', Police: 'غموض وتحقيق', Crime: 'غموض وتحقيق', Animals: 'حيوانات',
  'Time Travel': 'خيال علمي', 'Super Power': 'أكشن', 'Martial Arts': 'أكشن', Military: 'أكشن',
  Magic: 'فانتازيا', Demons: 'فانتازيا', Survival: 'مغامرة', Travel: 'مغامرة', Isekai: 'فانتازيا',
  Swordplay: 'أكشن',
};
const WIKI_GENRE_RULES = [
  [/أكشن|اكشن|قتال|action/, 'أكشن'], [/مغامر|adventure/, 'مغامرة'], [/كوميد|comedy/, 'كوميدي'],
  [/درام|drama/, 'دراما'], [/فانتاز|فنتاز|fantasy/, 'فانتازيا'], [/خيال علمي|science fiction|sci-fi/, 'خيال علمي'],
  [/رعب|horror/, 'رعب'], [/غموض|جريم|محقق|إثارة|اثارة|mystery|crime/, 'غموض وتحقيق'],
  [/رياض|sport/, 'رياضة'], [/موسيق|music/, 'موسيقي'], [/رومانس|romance/, 'رومانسي'],
  [/تاريخ|historical/, 'تاريخي'], [/سحر|magic/, 'بنات السحر'], [/طبخ|cooking/, 'طبخ'],
  [/روبوت|ميكا|robot|mecha/, 'روبوتات'], [/فضاء|فضائي|space/, 'فضاء'], [/قراصن|pirate/, 'قراصنة'],
  [/نينج|ساموراي|ninja|samurai/, 'نينجا وساموراي'], [/حيوان|animal/, 'حيوانات'], [/مدرس|school/, 'مدرسي'],
];

function load() { try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch (e) { return { results: {}, tried: {}, wiki: {} }; } }
function save(s) { fs.writeFileSync(STATE, JSON.stringify(s)); }
async function get(url, opts = {}, tries = 3) {
  for (let a = 0; a < tries; a++) {
    try {
      const res = await fetch(url, { ...opts, headers: { 'User-Agent': 'stardima-addon/1.0 (metadata)', ...(opts.headers || {}) } });
      if (res.status === 429) { await sleep(1500 * (a + 1)); continue; }
      if (!res.ok) return null;
      return res;
    } catch (e) { await sleep(400 * (a + 1)); }
  }
  return null;
}
function tokens(s) { return normTitle(s).replace(/[^\p{L}\p{N} ]/gu, ' ').split(/\s+/).filter((t) => t && t.length >= 2); }
function sharesToken(a, b) {
  const A = new Set(tokens(a)), B = new Set(tokens(b));
  for (const t of A) if (B.has(t) && (t.length >= 4 || /^\d+$/.test(t))) return true;
  return false;
}
function similarTitle(a, b) {
  const na = normTitle(a).replace(/[^\p{L}\p{N} ]/gu, ' ').replace(/\s+/g, ' ').trim();
  const nb = normTitle(b).replace(/[^\p{L}\p{N} ]/gu, ' ').replace(/\s+/g, ' ').trim();
  if (!na || !nb) return false;
  return na === nb || na.includes(nb) || nb.includes(na) || sharesToken(a, b);
}
async function anilistBatch(queries) {
  const q = 'query{' + queries.map((t, i) =>
    `q${i}:Page(perPage:3){media(search:${JSON.stringify(t)},type:ANIME){id title{romaji english native} synonyms genres startDate{year} popularity tags{name rank}}}`
  ).join(' ') + '}';
  const res = await get('https://graphql.anilist.co', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: q }),
  });
  if (!res) return queries.map(() => []);
  const j = await res.json().catch(() => ({}));
  return queries.map((_, i) => ((j.data || {})[`q${i}`] || {}).media || []);
}
// accept an AniList candidate only when the year agrees, or it is very popular
const isArabic = (t) => /[\u0600-\u06FF]/.test(t || '');
// A match is trusted when the evidence is strong:
//  - Latin query  -> the candidate must actually look like the same title
//  - Arabic query -> AniList only returns something when one of its synonyms
//                    matches, which is a strong signal in itself, so popularity
//                    and year decide instead of spelling.
function pickCandidate(list, title, year) {
  const arabic = isArabic(title);
  let best = null;
  for (const m of (list || []).slice(0, 5)) {
    const ay = m?.startDate?.year || 0, pop = m?.popularity || 0;
    const names = [m?.title?.english, m?.title?.romaji, m?.title?.native, ...(m?.synonyms || [])].filter(Boolean);
    const sim = names.some((n) => similarTitle(title, n));
    if (!arabic && !sim) continue;
    const ydiff = year && ay ? Math.abs(ay - year) : null;
    let conf = '';
    if (arabic) {
      if (ydiff !== null && ydiff <= 2) conf = 'high';
      else if (pop >= 4000) conf = 'high';
      else if (pop >= 300) conf = 'medium';
      else conf = '';                        // too obscure to trust on the name alone
    } else {
      if (sim && ydiff !== null && ydiff <= 2) conf = 'high';
      else if (sim && pop >= 800) conf = 'medium';
      else conf = '';
    }
    if (!conf) continue;
    const score = (conf === 'high' ? 100 : 50) + Math.min(pop / 1000, 30) + (ydiff !== null ? Math.max(0, 10 - ydiff) : 0) + (sim ? 15 : 0);
    if (!best || score > best.score) best = { m, conf, score };
  }
  return best;
}
function tagsFromAniList(m) {
  const out = []; const add = (t) => { if (t && out.indexOf(t) < 0) out.push(t); };
  for (const g of m.genres || []) add(ANILIST_GENRES[g]);
  for (const t of (m.tags || []).filter((x) => x.rank >= 65).slice(0, 6)) add(ANILIST_TAGS[t.name]);
  return out;
}
const WORK_P31 = new Set([
  'Q5398426','Q581714','Q63952888','Q506240','Q1261214','Q202866','Q15416','Q93204','Q1107','Q8274',
  'Q220898','Q1002697','Q21191270','Q29168811','Q24856','Q1259759','Q196600','Q1667921','Q3464665',
]); // tv series, film, animated series, anime, manga, video game, cartoon…
// Arabic titles -> ar.wikipedia; Latin titles -> en.wikipedia (they simply are
// not in the Arabic one). The article is then matched back to a Wikidata item.
async function wikiLookup(title, year) {
  const arabic = isArabic(title);
  const host = arabic ? 'ar.wikipedia.org' : 'en.wikipedia.org';
  const u = `https://${host}/w/api.php?action=query&generator=search&gsrsearch=` +
    encodeURIComponent(title) + '&gsrlimit=1&prop=langlinks|pageprops&lllang=' + (arabic ? 'en' : 'ar') +
    '&format=json&redirects=1';
  const r = await get(u);
  if (!r) return null;
  const j = await r.json().catch(() => ({}));
  const page = Object.values(j?.query?.pages || {})[0];
  if (!page) return null;
  const article = page.title || '';
  const other = page?.langlinks?.[0]?.['*'] || null;
  if (!arabic && !similarTitle(title, article)) return null;  // latin titles must match the article
  if (arabic && !similarTitle(title, article)) {
    // Arabic names often differ from Wikipedia's name for the same show, so a
    // mismatch is allowed only when the article is clearly a work (checked later).
    if (!page?.pageprops?.wikibase_item) return null;
  }
  return {
    article,
    en: arabic ? other : title,      // the AniList query language
    qid: page?.pageprops?.wikibase_item || null,
    lang: arabic ? 'ar' : 'en',
  };
}
async function wikidataInfo(qid) {
  if (!qid) return null;
  const r = await get(`https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${qid}&props=claims&format=json`);
  if (!r) return null;
  const j = await r.json().catch(() => ({}));
  const ent = (j?.entities || {})[qid];
  if (!ent) return null;
  const claims = ent.claims || {};
  const p31 = (claims.P31 || []).map((c) => c?.mainsnak?.datavalue?.value?.id).filter(Boolean);
  const gids = (claims.P136 || []).map((c) => c?.mainsnak?.datavalue?.value?.id).filter(Boolean).slice(0, 8);
  let labels = [];
  if (gids.length) {
    const lr = await get(`https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${gids.join('|')}&props=labels&languages=ar|en&format=json`);
    const lj = lr ? await lr.json().catch(() => ({})) : {};
    labels = gids.map((g) => ((lj?.entities || {})[g] || {}).labels?.ar?.value || ((lj?.entities || {})[g] || {}).labels?.en?.value || '').filter(Boolean);
  }
  return { isWork: p31.some((x) => WORK_P31.has(x)), p31, genres: labels };
}
function wikiGenresToTags(labels) {
  const out = [];
  for (const raw of labels) {
    const n = normTitle(raw);
    for (const [re, tag] of WIKI_GENRE_RULES) if (re.test(n) && tag && out.indexOf(tag) < 0) out.push(tag);
  }
  return out;
}
async function pool(items, worker, conc) {
  let i = 0;
  await Promise.all(Array.from({ length: conc }, async () => { while (i < items.length) { const k = i++; await worker(items[k]); } }));
}

(async () => {
  const mode = process.argv[2] || '600';
  const idx = JSON.parse(fs.readFileSync(path.join(__dirname, 'catalog-index.min.json'), 'utf8'));
  const base = JSON.parse(fs.readFileSync(path.join(__dirname, 'our-genres.json'), 'utf8'));
  const labels = base.labels;
  const all = [];
  for (const sec of ['series', 'movies']) for (const it of idx[sec].items) all.push({ slug: it[0], title: it[1], year: parseInt(it[3], 10) || 0 });

  // ---------------- assemble ----------------
  if (mode === 'final') {
    const s = load();
    const items = {}, source = {}, match = {}, confidence = {};
    let nHeur = 0, nMeta = 0;
    for (const x of all) {
      const r = s.results[x.slug];
      let tags = [], src = '';
      if (r && r.tags.length) { tags = r.tags; src = r.source; nMeta++; }
      else { const raw = base.items[x.slug]; if (raw) { tags = String(raw).split(',').map((n) => labels[+n]).filter(Boolean); src = 'heuristic'; } }
      if (!tags.length) continue;
      const idxs = [...new Set(tags.map((t) => labels.indexOf(t)).filter((i) => i >= 0))];
      if (!idxs.length) continue;
      items[x.slug] = idxs.join(',');
      source[x.slug] = src;
      if (r) { match[x.slug] = r.match || ''; confidence[x.slug] = r.conf || ''; }
      if (src === 'heuristic') nHeur++;
    }
    const out = { labels, items, source, match, confidence, built: new Date().toISOString(), via: 'build-meta' };
    fs.writeFileSync(path.join(__dirname, 'our-genres.json'), JSON.stringify(out));
    const bySrc = {}; for (const v of Object.values(source)) bySrc[v] = (bySrc[v] || 0) + 1;
    console.log(`assembled: ${Object.keys(items).length}/${all.length} tagged (${((Object.keys(items).length / all.length) * 100).toFixed(0)}%)`);
    console.log('  by source:', JSON.stringify(bySrc));
    console.log('  from real metadata:', nMeta, '| heuristics:', nHeur);
    return;
  }

  // ---------------- process a chunk ----------------
  const n = parseInt(mode, 10) || 600;
  const s = load();
  // Arabic-titled titles first: that is where the metadata sources are strongest,
  // and they are the bulk of this library.
  const todo = all.filter((x) => !s.tried[x.slug])
    .sort((a, b) => (isArabic(b.title) ? 1 : 0) - (isArabic(a.title) ? 1 : 0))
    .slice(0, n);
  console.log(`chunk: ${todo.length} titles (already tried: ${Object.keys(s.tried).length}/${all.length})`);
  if (!todo.length) { console.log('  nothing left — run "final"'); return; }

  // pass 1 — AniList with the Arabic title
  let matched = 0;
  for (let i = 0; i < todo.length; i += BATCH) {
    const b = todo.slice(i, i + BATCH);
    const res = await anilistBatch(b.map((x) => x.title));
    b.forEach((x, k) => {
      const pick = pickCandidate(res[k], x.title, x.year, false);
      if (pick) { s.results[x.slug] = { tags: tagsFromAniList(pick.m), source: 'anilist(ar)', match: pick.m.title.english || pick.m.title.romaji || '', conf: pick.conf }; matched++; }
    });
    if (i % (BATCH * 10) === 0) { save(s); process.stdout.write(`\r  anilist(ar): ${i + b.length}/${todo.length} matched ${matched}   `); }
  }
  console.log(`\n  pass1 done: ${matched} matched`);

  // pass 2 — Wikipedia (Arabic article -> English title) -> AniList(English)
  const misses = todo.filter((x) => !s.results[x.slug]);
  console.log(`  pass2: ${misses.length} misses -> Wikipedia -> AniList(en)`);
  const wikiNow = {};
  await pool(misses, async (x) => {
    if (s.wiki[x.slug]) { wikiNow[x.slug] = s.wiki[x.slug]; return; }
    const w = await wikiLookup(x.title.replace(/[:：].*$/, '').trim(), x.year);
    if (w) { wikiNow[x.slug] = w; s.wiki[x.slug] = w; }
  }, CONC_WIKI);
  save(s);
  console.log(`  wikipedia articles: ${Object.keys(wikiNow).length}`);
  // resolve each article's Wikidata once (tells us whether it is a work at all)
  const wikiInfo = {};
  await pool(Object.entries(wikiNow).filter(([, w]) => w.qid), async ([slug, w]) => {
    wikiInfo[slug] = await wikidataInfo(w.qid);
  }, 4);
  const enList = misses.filter((x) => wikiNow[x.slug] && wikiNow[x.slug].en && !isArabic(wikiNow[x.slug].en));
  let m2 = 0;
  for (let i = 0; i < enList.length; i += BATCH) {
    const b = enList.slice(i, i + BATCH);
    const res = await anilistBatch(b.map((x) => wikiNow[x.slug].en));
    b.forEach((x, k) => {
      const pick = pickCandidate(res[k], wikiNow[x.slug].en, x.year);
      if (pick) { s.results[x.slug] = { tags: tagsFromAniList(pick.m), source: 'anilist(en)', match: pick.m.title.english || pick.m.title.romaji || '', conf: pick.conf }; m2++; }
    });
    if (i % (BATCH * 5) === 0) { save(s); process.stdout.write(`\r  anilist(en): ${i + b.length}/${enList.length} matched ${m2}   `); }
  }
  console.log(`\n  pass2 done: ${m2} matched`);

  // pass 3 — Wikidata genre statements
  const misses2 = misses.filter((x) => !s.results[x.slug] && wikiNow[x.slug] &&
    (!isArabic(x.title) ? wikiInfo[x.slug] && wikiInfo[x.slug].isWork : true));
  console.log(`  pass3: ${misses2.length} -> Wikidata`);
  let m3 = 0;
  await pool(misses2, async (x) => {
    const info = wikiInfo[x.slug] || (wikiNow[x.slug].qid ? await wikidataInfo(wikiNow[x.slug].qid) : null);
    const tags = wikiGenresToTags((info && info.genres) || []);
    if (tags.length) { s.results[x.slug] = { tags, source: 'wikidata', match: wikiNow[x.slug].article, conf: 'medium' }; m3++; }
  }, 6);
  console.log(`  pass3 done: ${m3} matched`);

  todo.forEach((x) => { s.tried[x.slug] = 1; });
  save(s);
  console.log(`\n  chunk summary: anilist(ar) ${matched} + anilist(en) ${m2} + wikidata ${m3} = ${matched + m2 + m3} from metadata`);
})().catch((e) => { console.error('ERR', e.stack || e.message); process.exit(1); });
