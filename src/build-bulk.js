// Method 2: download reference DATABASES once, then match locally.
//   1. AniList  : ~8000 anime (title variants in many languages incl. Arabic, genres, year)
//   2. TVMaze   : ~80k shows (English names, genres, year) — covers Western cartoons
//   3. match every Stardima title locally against both (normalised Arabic + Latin)
// Much faster than per-title API search, and the synonym lists give far better recall.
const fs = require('fs');
const path = require('path');
const { normTitle } = require('./lib/stardima');

const AL_FILE = path.join(__dirname, 'ref-anilist.json');
const TV_FILE = path.join(__dirname, 'ref-tvmaze.json');
const OUT = path.join(__dirname, 'bulk-matches.json');
const UA = 'stardima-addon/1.0 (metadata)';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MODE = process.argv[2] || 'all';        // download | match | all
const AL_PAGES = parseInt(process.argv[3] || '160', 10);
const TV_PAGES = parseInt(process.argv[4] || '340', 10);

// ---------- genre maps ----------
const AL_GENRES = { Action: 'أكشن', Adventure: 'مغامرة', Comedy: 'كوميدي', Drama: 'دراما', Fantasy: 'فانتازيا',
  Horror: 'رعب', 'Mahou Shoujo': 'بنات السحر', Mecha: 'روبوتات', Music: 'موسيقي', Mystery: 'غموض وتحقيق',
  Romance: 'رومانسي', 'Sci-Fi': 'خيال علمي', 'Slice of Life': 'دراما', Sports: 'رياضة',
  Supernatural: 'فانتازيا', Thriller: 'غموض وتحقيق', Psychological: 'غموض وتحقيق' };
const AL_TAGS = { Ninja: 'نينجا وساموراي', Samurai: 'نينجا وساموراي', Pirates: 'قراصنة', Cooking: 'طبخ',
  School: 'مدرسي', Historical: 'تاريخي', Space: 'فضاء', 'Outer Space': 'فضاء', Robot: 'روبوتات',
  Racing: 'سيارات', Cars: 'سيارات', Music: 'موسيقي', Idol: 'موسيقي', Detective: 'غموض وتحقيق',
  Police: 'غموض وتحقيق', Crime: 'غموض وتحقيق', Animals: 'حيوانات', 'Time Travel': 'خيال علمي',
  'Super Power': 'أكشن', 'Martial Arts': 'أكشن', Military: 'أكشن', Magic: 'فانتازيا', Demons: 'فانتازيا',
  Survival: 'مغامرة', Travel: 'مغامرة', Isekai: 'فانتازيا', Swordplay: 'أكشن' };
const TV_GENRES = { Action: 'أكشن', Adventure: 'مغامرة', Comedy: 'كوميدي', Drama: 'دراما', Fantasy: 'فانتازيا',
  Horror: 'رعب', Mystery: 'غموض وتحقيق', Romance: 'رومانسي', 'Science-Fiction': 'خيال علمي',
  Thriller: 'غموض وتحقيق', Crime: 'غموض وتحقيق', Family: null, Anime: null, Music: 'موسيقي',
  Supernatural: 'فانتازيا', Sports: 'رياضة', Espionage: 'أكشن', War: 'أكشن', History: 'تاريخي',
  Food: 'طبخ', Nature: 'حيوانات', Travel: 'مغامرة', Western: 'مغامرة', Medical: null, Legal: null,
  Children: null, 'Awards Show': null, 'Talk Show': null, 'Game Show': null, 'Reality': null, 'Romance': 'رومانسي' };

// ---------- download: AniList ----------
async function downloadAniList() {
  const out = [];
  for (let page = 1; page <= AL_PAGES; page++) {
    const q = `query{Page(page:${page},perPage:50){media(sort:POPULARITY_DESC,type:ANIME){id title{romaji english native} synonyms genres startDate{year} popularity tags{name rank}}}}`;
    let j = null;
    for (let a = 0; a < 4; a++) {
      try {
        const r = await fetch('https://graphql.anilist.co', { method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': UA }, body: JSON.stringify({ query: q }) });
        if (r.status === 429) { await sleep(3000 * (a + 1)); continue; }
        if (!r.ok) { await sleep(800); continue; }
        j = await r.json(); break;
      } catch (e) { await sleep(800); }
    }
    const media = j && j.data && j.data.Page && j.data.Page.media;
    if (!media || !media.length) { console.log(`  anilist: stopped at page ${page}`); break; }
    for (const m of media) out.push(m);
    if (page % 20 === 0) {
      fs.writeFileSync(AL_FILE, JSON.stringify(out));
      process.stdout.write(`\r  anilist: ${out.length} entries (page ${page}/${AL_PAGES})   `);
    }
    await sleep(750);
  }
  fs.writeFileSync(AL_FILE, JSON.stringify(out));
  console.log(`\n  anilist downloaded: ${out.length}`);
}
// ---------- download: TVMaze ----------
async function downloadTVMaze() {
  const out = [];
  for (let page = 0; page < TV_PAGES; page++) {
    let d = null;
    for (let a = 0; a < 3; a++) {
      try {
        const r = await fetch(`https://api.tvmaze.com/shows?page=${page}`, { headers: { 'User-Agent': UA } });
        if (r.status === 429) { await sleep(1500 * (a + 1)); continue; }
        if (r.status === 404) { d = []; break; }
        if (!r.ok) { await sleep(500); continue; }
        d = await r.json(); break;
      } catch (e) { await sleep(500); }
    }
    if (!Array.isArray(d) || !d.length) { console.log(`  tvmaze: finished at page ${page}`); break; }
    for (const s of d) out.push({ name: s.name, genres: s.genres || [], year: parseInt((s.premiered || '').slice(0, 4), 10) || 0, lang: s.language || '', type: s.type || '' });
    if (page % 40 === 0) {
      fs.writeFileSync(TV_FILE, JSON.stringify(out));
      process.stdout.write(`\r  tvmaze: ${out.length} shows (page ${page})   `);
    }
    await sleep(420);
  }
  fs.writeFileSync(TV_FILE, JSON.stringify(out));
  console.log(`\n  tvmaze downloaded: ${out.length}`);
}

// ---------- local matching ----------
const LATIN_STOP = new Set(['the', 'a', 'an', 'of', 'and', 'la', 'le', 'les', 'el', 'los', 'las', 'de', 'du', 'in', 'to']);
function normLatin(s) {
  return String(s || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((t) => t && !LATIN_STOP.has(t)).join(' ').trim();
}
// Arabic: normalise letters AND drop the definite article so 'المحقق كونان' and
// 'محقق كونان' collapse to the same key (the site and the databases disagree on it).
function normArabic(s) {
  const base = normTitle(s || '').replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
  return base.split(' ').map((t) => (t.length > 3 && t.startsWith('ال') ? t.slice(2) : t)).join(' ').trim();
}
function normKey(title) {
  const ar = /[\u0600-\u06FF]/.test(title || '');
  return ar ? 'A:' + normArabic(title) : 'L:' + normLatin(title);
}
function toksOf(key) { return key.slice(2).split(' ').filter((t) => t.length >= 2); }
function bigrams(s) { const out = new Set(); for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2)); return out; }
function dice(a, b) {
  if (!a.length || !b.length) return 0;
  const A = bigrams(a), B = bigrams(b); let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  return (2 * inter) / (A.size + B.size);
}
function isDistinctive(t) { return t.length >= 4 || /^\d+$/.test(t); }

function buildRefIndex(al, tv) {
  const exact = new Map();   // normalised key -> entries
  const byFirst = new Map(); // first token -> [{key, entry}]
  const add = (key, entry) => {
    if (!key || key.length < 4) return;
    const e = exact.get(key); if (e) { e.push(entry); } else exact.set(key, [entry]);
    const first = toksOf(key)[0] || '';
    const list = byFirst.get(first); const rec = { key, entry };
    if (list) list.push(rec); else byFirst.set(first, [rec]);
  };
  for (const m of al) {
    const names = [m.title.romaji, m.title.english, m.title.native, ...(m.synonyms || [])].filter(Boolean);
    let genres = (m.genres || []).map((g) => AL_GENRES[g]).filter(Boolean)
      .concat((m.tags || []).filter((t) => t.rank >= 68).map((t) => AL_TAGS[t.name]).filter(Boolean));
    genres = [...new Set(genres)];
    if (!genres.length) continue;
    const entry = { kind: 'anilist', genres, year: m.startDate?.year || 0, pop: m.popularity || 0, label: m.title.english || m.title.romaji || m.title.native };
    for (const n of names) add(normKey(n), entry);
  }
  for (const s of tv) {
    let genres = (s.genres || []).map((g) => TV_GENRES[g]).filter(Boolean);
    genres = [...new Set(genres)];
    if (!genres.length) continue;
    const entry = { kind: 'tvmaze', genres, year: s.year || 0, pop: 300, label: s.name };
    add(normKey(s.name), entry);
  }
  return { exact, byFirst };
}
function matchTitle(title, year, index) {
  const key = normKey(title);
  const toks = toksOf(key);
  if (!toks.length) return null;
  const cands = new Map(); // entry -> why
  const push = (e, why) => { const prev = cands.get(e); if (!prev || prev === 'subset') cands.set(e, why); };
  for (const e of (index.exact.get(key) || [])) push(e, 'exact');
  // subset: every reference token appears in our title, or vice versa
  const seen = new Set();
  const considerKey = (k) => {
    if (seen.has(k)) return; seen.add(k);
    const rt = toksOf(k);
    if (!rt.length) return;
    const set = new Set(toks);
    const refInOurs = rt.every((t) => set.has(t));
    const oursInRef = toks.every((t) => new Set(rt).has(t));
    if (!refInOurs && !oursInRef) return;
    if (!(rt.some(isDistinctive) || toks.some(isDistinctive))) return;
    if (Math.min(rt.length, toks.length) < 2 && !(rt.length === 1 && toks.length === 1)) return;
    for (const e of (index.exact.get(k) || [])) push(e, 'subset');
  };
  for (const t of toks) if (isDistinctive(t)) for (const rec of (index.byFirst.get(t) || [])) considerKey(rec.key);
  for (const rec of (index.byFirst.get(toks[0]) || [])) considerKey(rec.key);
  // fuzzy: same script, first token equal or one shares a distinctive token
  if (key.length >= 8) {
    for (const t of [...new Set([toks[0], ...toks.filter(isDistinctive)])].slice(0, 3)) {
      for (const rec of (index.byFirst.get(t) || [])) {
        seen.add(rec.key);
        if (Math.abs(rec.key.length - key.length) > 6) continue;
        if (dice(rec.key, key) >= 0.82) for (const e of (index.exact.get(rec.key) || [])) push(e, 'fuzzy');
      }
    }
  }
  if (!cands.size) return null;
  const scored = [...cands.entries()].map(([e, why]) => {
    const ydiff = year && e.year ? Math.abs(year - e.year) : null;
    let score = why === 'exact' ? 22 : why === 'fuzzy' ? 14 : 12;
    if (ydiff !== null) score += ydiff === 0 ? 8 : ydiff === 1 ? 5 : ydiff <= 2 ? 2 : -12;
    score += Math.min(e.pop / 5000, 4);
    if (e.kind === 'anilist') score += 1;
    return { e, why, ydiff, score };
  }).sort((a, b) => b.score - a.score);
  const best = scored[0];
  if (best.score < 14) return null;
  if (best.why === 'subset' && toksOf(key).length === 1 && best.e.year && year && Math.abs(best.e.year - year) > 2) return null;
  return { tags: best.e.genres, match: best.e.label, kind: best.e.kind, why: best.why,
    conf: best.score >= 26 ? 'high' : best.score >= 18 ? 'medium' : 'low', ydiff: best.ydiff };
}

(async () => {
  if (MODE === 'download' || MODE === 'all') {
    console.log('downloading reference databases...');
    await Promise.all([downloadAniList(), downloadTVMaze()]);
  }
  if (MODE === 'match' || MODE === 'all') {
    const al = JSON.parse(fs.readFileSync(AL_FILE, 'utf8'));
    const tv = JSON.parse(fs.readFileSync(TV_FILE, 'utf8'));
    const index = buildRefIndex(al, tv);
    console.log(`reference index built: ${index.size} name keys (anilist ${al.length}, tvmaze ${tv.length})`);
    const cats = JSON.parse(fs.readFileSync(path.join(__dirname, 'catalog-index.min.json'), 'utf8'));
    const all = [];
    for (const sec of ['series', 'movies']) for (const it of cats[sec].items) all.push({ slug: it[0], title: it[1], year: parseInt(it[3], 10) || 0 });
    const out = {}; const stat = { high: 0, medium: 0, low: 0 }; const byKind = {};
    const t0 = Date.now();
    for (const x of all) {
      const r = matchTitle(x.title, x.year, index);
      if (!r) continue;
      out[x.slug] = { tags: r.tags, source: 'bulk:' + r.kind, match: r.match, conf: r.conf, ydiff: r.ydiff };
      stat[r.conf]++; byKind[r.kind] = (byKind[r.kind] || 0) + 1;
    }
    fs.writeFileSync(OUT, JSON.stringify({ results: out, built: new Date().toISOString(), ref: { anilist: al.length, tvmaze: tv.length } }));
    console.log(`matched ${Object.keys(out).length}/${all.length} (${((Object.keys(out).length / all.length) * 100).toFixed(0)}%) in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    console.log('  confidence:', JSON.stringify(stat), '| by source:', JSON.stringify(byKind));
    const nameOf = {}; for (const sec of ['series', 'movies']) for (const it of cats[sec].items) nameOf[it[0]] = it[1];
    console.log('\n--- samples ---');
    const keys = Object.keys(out).filter((_, i) => i % Math.max(1, Math.floor(Object.keys(out).length / 22)) === 0).slice(0, 22);
    for (const s of keys) console.log(`  ${(nameOf[s] || s).slice(0, 30).padEnd(32)} -> ${(out[s].match || '').slice(0, 26).padEnd(28)} | ${out[s].tags.join(', ')} [${out[s].conf}${out[s].ydiff !== null && out[s].ydiff !== undefined ? ' Δ' + out[s].ydiff : ''}]`);
  }
})().catch((e) => { console.error('ERR', e.stack || e.message); process.exit(1); });
