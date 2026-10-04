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

const norm = (s) => String(s || '')
  .normalize('NFKC')
  .replace(/[\u064B-\u0652\u0640]/g, '')
  .replace(/[أإآٱ]/g, 'ا').replace(/ى/g, 'ي').replace(/ؤ/g, 'و').replace(/ئ/g, 'ي').replace(/ة/g, 'ه')
  .replace(/[^\p{L}\p{N}\s]/gu, ' ')
  .toLowerCase().replace(/\s+/g, ' ').trim();
const clean = (s) => norm(s)
  .replace(/\b(مسلسل|series|movie|film|فيلم|الفيلم|special|سبيشل|مترجم|مدبلج|كامل|كاملة|the)\b/g, ' ')
  .replace(/\s+/g, ' ').trim();

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
function score(ours, cand, kind) {
  const wantSeries = kind === 'series';
  const candSeries = cand.media_type ? cand.media_type === 'tv' : wantSeries;
  if (cand.media_type && candSeries !== wantSeries) return -1;
  const names = [cand.name, cand.title, cand.original_name, cand.original_title].filter(Boolean).map(norm);
  const ours_ = clean(ours.title);
  let titleHit = 0;
  for (const n of names) if (n === norm(ours.title) || n === ours_) { titleHit = 2; break; }
  if (!titleHit) for (const n of names) if (n && (n.indexOf(ours_) >= 0 || ours_.indexOf(n) >= 0) && ours_.length > 3) { titleHit = 1; break; }
  if (!titleHit) return -1;
  const candYear = Number(String(cand.first_air_date || cand.release_date || '').slice(0, 4)) || 0;
  const yearOk = !ours.year || !candYear ? 0.5 : Math.abs(candYear - Number(String(ours.year).slice(0, 4))) <= 1 ? 1 : 0;
  if (yearOk === 0) return -1;
  return titleHit * 2 + yearOk;
}

async function matchOne(ours) {
  const tries = [ours.title];
  const c = clean(ours.title);
  if (c && c !== norm(ours.title)) tries.push(c);
  let best = null;
  for (const q of tries) {
    const j = await api('/search/multi', { query: q, language: 'ar-SA', include_adult: 'false' });
    if (!j || !Array.isArray(j.results)) continue;
    for (const cand of j.results) {
      if (cand.media_type === 'person') continue;
      const s = score(ours, cand, ours.kind);
      if (s > 0 && (!best || s > best.s)) best = { s, cand };
    }
    if (best && best.s >= 3.5) break;
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
  let todo = ours.filter((o) => !(o.key in state.done));
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
