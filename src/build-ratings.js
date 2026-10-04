// Links every work in the library to TMDB and stores rating + overview.
// Resumable: run it again any time, it only asks about what is still missing.
// Key: TMDB v3 api key (32 hex) or v4 read token (JWT), via TMDB_API_KEY.
const fs = require('fs');
const path = require('path');
const ROOT = __dirname;
const STATE = path.join(ROOT, 'ratings-state.json');
const OUT = path.join(ROOT, 'ratings.json');
const CONC = Number(process.env.CONC || 5);
const CAP = Number(process.env.CAP || 0); // 0 = all
const KEY = process.env.TMDB_API_KEY || '';

const AR_DIGITS = '٠١٢٣٤٥٦٧٨٩';
const norm = (s) => String(s || '')
  .normalize('NFKC')
  .replace(/[٠-٩]/g, (d) => String(AR_DIGITS.indexOf(d)))
  .replace(/[\u064B-\u0652\u0640]/g, '')
  .replace(/[أإآٱ]/g, 'ا').replace(/ى/g, 'ي').replace(/ؤ/g, 'و').replace(/ئ/g, 'ي').replace(/ة/g, 'ه')
  .replace(/[^\p{L}\p{N}\s]/gu, ' ')
  .toLowerCase().replace(/\s+/g, ' ').trim();
const clean = (s) => norm(s)
  .replace(/\b(مسلسل|series|movie|film|فيلم|الفيلم|special|سبيشل|مترجم|مدبلج|كامل|كاملة|the|vol|volume|part|chapter|ep|episode)\b/g, ' ')
  .replace(/\s+/g, ' ').trim();
// comparison form: also drops the Arabic article so "للمستقبل" and "المستقبل" meet
const light = (s) => clean(s)
  .split(' ')
  .map((w) => w.replace(/^(ال|لل|بال|وال|فال)/, ''))
  .filter((w) => w && w.length > 1)
  .sort()
  .join(' ');

function api(pathname, params) {
  const u = new URL('https://api.themoviedb.org/3' + pathname);
  for (const [k, v] of Object.entries(params || {})) if (v != null) u.searchParams.set(k, v);
  const headers = { Accept: 'application/json' };
  if (KEY.startsWith('ey')) headers.Authorization = 'Bearer ' + KEY; // v4 read token
  else u.searchParams.set('api_key', KEY);                            // v3 key
  return fetch(u, { headers }).then(async (r) => {
    if (r.status === 429) { await new Promise((s) => setTimeout(s, 1500)); return null; }
    if (!r.ok) return null;
    return r.json();
  }).catch(() => null);
}

// candidates come back with a matching score; we only accept a confident pair so the
// add-on never shows the rating of a lookalike show
function score(ours, cand, kind, aliases) {
  // an alias (usually the English title from Wikipedia) counts as a same-name hit
  if (aliases && aliases.length) {
    const candNames = [cand.name, cand.original_name, cand.title, cand.original_title].filter(Boolean).map(norm);
    const hit = aliases.some((a) => { const n = norm(a); return n && candNames.includes(n); });
    if (hit) {
      const candSeries = cand.media_type ? cand.media_type === 'tv' : kind === 'series';
      if (cand.media_type && candSeries !== (kind === 'series')) return -1;
      if (!cand.overview && !cand.vote_count) return -1;
      const oy = Number(String(ours.year || '').slice(0, 4)) || 0;
      const cy = Number(String(cand.first_air_date || cand.release_date || '').slice(0, 4)) || 0;
      if (oy >= 1910 && cy > 0 && Math.abs(cy - oy) > 2) return -1;   // alias needs the year to agree
      return 3.5;
    }
  }
  const wantSeries = kind === 'series';
  const candSeries = cand.media_type ? cand.media_type === 'tv' : wantSeries;
  if (cand.media_type && candSeries !== wantSeries) return -1;
  if (!cand.overview && !cand.vote_count) return -1;      // nothing to show anyway
  const names = [cand.name, cand.title, cand.original_name, cand.original_title].filter(Boolean);
  const ourN = norm(ours.title), ourC = clean(ours.title), ourL = light(ours.title);
  let titleHit = 0;
  for (const raw of names) {
    const n = norm(raw);
    if (n === ourN || n === ourC) { titleHit = 2; break; }               // same title exactly
  }
  if (!titleHit) {
    for (const raw of names) {
      const l = light(raw);
      if (!l) continue;
      const a = l.split(' '), b = ourL.split(' ');
      const same = a.length === b.length && a.every((w, i) => w === b[i]);
      if (same && a.length >= 2) { titleHit = 1.5; break; }              // same words, different articles
      if (same && a.length === 1 && a[0].length >= 6) { titleHit = 1.5; break; }
    }
  }
  if (!titleHit) {                                                       // one name inside the other
    for (const raw of names) {
      const n = clean(raw);
      if (n && ourC && n.length > 3 && (n.indexOf(ourC) >= 0 || ourC.indexOf(n) >= 0)) { titleHit = 1; break; }
    }
  }
  if (!titleHit) return -1;
  const ourYear = Number(String(ours.year || '').slice(0, 4)) || 0;
  const candYear = Number(String(cand.first_air_date || cand.release_date || '').slice(0, 4)) || 0;
  const known = ourYear >= 1910 && candYear > 0;
  if (!known) return titleHit * 2 + 0.5;
  const diff = Math.abs(candYear - ourYear);
  if (diff <= 1) return titleHit * 2 + 1;
  if (titleHit >= 2) return titleHit * 2 - 0.5;   // exact title, our row/metadata year disagrees
  return -1;
}

// The long tail of Arabic titles simply is not in TMDB's search index. Wikipedia is: we
// look the Arabic name up there, follow the English interlanguage link, and use that name
// to find the same work in TMDB. The TMDB side still has to agree on media type and year.
async function wikiEnglish(title) {
  const H = { 'User-Agent': 'karton-zaman-addon/1.0 (addon ratings link-up)' };
  const u = new URL('https://ar.wikipedia.org/w/api.php');
  u.search = new URLSearchParams({ action: 'query', list: 'search', srsearch: String(title), srlimit: '3', format: 'json' }).toString();
  let j;
  try { j = await fetch(u, { headers: H }).then((r) => r.json()); } catch (e) { return null; }
  const hits = (j && j.query && j.query.search) || [];
  if (!hits.length) return null;
  const pick = hits.find((h) => light(h.title) === light(title)) || (light(hits[0].title).split(' ').some((w) => light(title).split(' ').includes(w)) ? hits[0] : null);
  if (!pick) return null;
  const u2 = new URL('https://ar.wikipedia.org/w/api.php');
  u2.search = new URLSearchParams({ action: 'query', titles: pick.title, prop: 'langlinks', lllang: 'en', format: 'json', redirects: '1' }).toString();
  try {
    const j2 = await fetch(u2, { headers: H }).then((r) => r.json());
    const pages = (j2 && j2.query && j2.query.pages) || {};
    for (const k of Object.keys(pages)) {
      const ll = (pages[k].langlinks || [])[0];
      if (ll && ll['*']) return String(ll['*']).replace(/\s*\([^)]*\)\s*$/, '').trim(); // "Thunderbirds Are Go (TV series)"
    }
  } catch (e) { /* none */ }
  return null;
}

async function matchOne(ours) {
  // TMDB's Arabic index is picky: the same title with the article ("ال") attached, or
  // with a trailing number, can return nothing. So we ask with a few shapes of the same
  // name and keep whatever scores highest — the scoring itself stays strict, so a loose
  // search can never produce a loose match.
  const c = clean(ours.title);
  const noArt = c.split(' ').map((w) => w.replace(/^(ال|لل)/, '')).join(' ').trim();
  const noNum = c.replace(/\s*\d+\s*$/, '').trim();
  const two = c.split(' ').slice(0, 2).join(' ');
  const latin = (String(ours.title).match(/[A-Za-z][A-Za-z0-9 ':\-]{3,}/) || [''])[0].trim();
  const cands = [ours.title, c, noArt, noNum, noNum !== c ? noArt.replace(/\s*\d+\s*$/, '').trim() : '', two, latin];
  const seen = new Set();
  const queries = cands.filter((q) => { const k = (q || '').toLowerCase().trim(); if (!k || k.length < 3 || seen.has(k)) return false; seen.add(k); return true; }).slice(0, 5);
  let best = null;
  for (const q of queries) {
    const j = await api('/search/multi', { query: q, language: 'ar-SA', include_adult: 'false' });
    if (!j || !Array.isArray(j.results)) continue;
    for (const cand of j.results) {
      if (cand.media_type === 'person') continue;
      const s = score(ours, cand, ours.kind);
      if (s > 0 && (!best || s > best.s)) best = { s, cand };
    }
    if (best && best.s >= 3.5) break;
  }
  if (!best || best.s < 3) {
    const en = await wikiEnglish(ours.title);
    if (en && norm(en) !== norm(ours.title)) {
      const j = await api('/search/multi', { query: en, language: 'ar-SA', include_adult: 'false' });
      for (const cand of ((j && j.results) || [])) {
        if (cand.media_type === 'person') continue;
        const s = score(ours, cand, ours.kind, [en]);
        if (s > 0 && (!best || s > best.s)) best = { s, cand, via: 'wiki:' + en };
      }
    }
  }
  if (!best || best.s < 3) return null;
  const t = best.cand;
  const out = {
    id: t.id, media: t.media_type === 'tv' ? 'tv' : 'movie',
    title: t.name || t.title || '',
    year: Number(String(t.first_air_date || t.release_date || '').slice(0, 4)) || undefined,
    vote: typeof t.vote_average === 'number' && t.vote_average > 0 ? Math.round(t.vote_average * 10) / 10 : undefined,
    votes: t.vote_count || undefined,
    overview: (t.overview || '').trim() || undefined,
    poster: t.poster_path || undefined,      // /abc.jpg — the worker builds the URL
    backdrop: t.backdrop_path || undefined,
    via: best.via,
  };
  if (!out.vote && !out.overview) return null;
  return out;
}

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch (e) { return { done: {} }; }
}
function save(state) {
  const tmp = STATE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state));
  fs.renameSync(tmp, STATE);
  const items = {};
  for (const [k, v] of Object.entries(state.done)) if (v) items[k] = v;
  fs.writeFileSync(path.join(ROOT, 'ratings.json'), JSON.stringify({ measured: Date.now(), items }));
}

(async () => {
  if (!KEY) { console.error('  TMDB_API_KEY is missing'); process.exit(1); }
  let ours = [];
  const idx = JSON.parse(fs.readFileSync(path.join(ROOT, 'catalog-index.min.json'), 'utf8'));
  for (const kind of ['series', 'movies']) for (const it of idx[kind].items)
    ours.push({ key: 'stardima:' + it[0], title: it[1], year: it[3], kind: kind === 'series' ? 'series' : 'movie' });
  // the second source's own works are matched too (they show in the same catalogues)
  try {
    const jc = JSON.parse(fs.readFileSync(path.join(ROOT, 'jcartoon.json'), 'utf8'));
    for (const x of jc.series || []) ours.push({ key: 'jcseries-' + x.id, title: x.title, year: undefined, kind: 'series' });
    for (const x of jc.movies || []) ours.push({ key: 'jcartoon-' + x.id, title: x.title, year: undefined, kind: 'movie' });
  } catch (e) { /* optional */ }

  const state = loadState();
  const RETRY = process.env.RETRY_MISS === '1';
  let todo = ours.filter((o) => !(o.key in state.done) || (RETRY && state.done[o.key] === null));
  if (CAP) todo = todo.slice(0, CAP);
  console.log(`  الإجمالي ${ours.length} · مخلص ${ours.length - todo.length} · متبقي ${todo.length}`);
  let i = 0, hits = 0, n = 0;
  const workers = Array.from({ length: CONC }, async () => {
    while (i < todo.length) {
      const o = todo[i++];
      const v = await matchOne(o);
      state.done[o.key] = v || null;
      if (v) hits++;
      n++;
      if (n % 25 === 0) { save(state); process.stdout.write(`   ...${n}/${todo.length} · انطبق ${hits} (${Math.round(100 * hits / n)}%)\n`); }
    }
  });
  await Promise.all(workers);
  save(state);
  console.log(`  خلص: ${n} عنوان · انطبق ${hits} (${Math.round(100 * hits / Math.max(n, 1))}%)`);
  console.log('  الملف: ratings.json');
})();
