// Builds the jcartoon.top source for the addon from a full scan (/tmp/jc-full.json),
// because their episodeCount field lies: hundreds of series report 0 episodes yet
// serve real episodes. Every entry kept here is one we probed and saw a live .m3u8.
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, 'jcartoon.json');
const SRC = process.env.JC_FULL || '/tmp/jc-full.json';

const norm = (s) => String(s || '').normalize('NFKC').replace(/[أإآ]/g, 'ا').replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim().toLowerCase();

(async () => {
  const raw = JSON.parse(fs.readFileSync(SRC, 'utf8'));
  // Their /api/movies entries are the same ids that also appear under /api/series
  // (61 of them), so an id that is a film must not land in the series catalogue.
  const movieIds = new Set((raw.movies || []).filter((m) => m.probed_ok).map((m) => m.id));
  const series = [], movies = [];
  for (const s of raw.series || []) {
    if (!s.probed_ok || !(s.episodes || []).length) continue;
    if (movieIds.has(s.id)) continue; // it is a film, listed below
    series.push({
      id: s.id, title: s.title, poster: s.poster || '', desc: (s.desc || '').slice(0, 220), genre: s.genre || '',
      total: s.episodes.length,
      // compact: [episodeId, index, season, duration] — 13k episodes inline would bloat the worker
      episodes: s.episodes.map((e) => [e.id, e.index || 0, e.seasonNumber || 0, e.duration || 0]),
    });
  }
  for (const m of raw.movies || []) {
    if (!m.probed_ok) continue;
    movies.push({ id: m.id, title: m.title, poster: m.poster || '', desc: m.desc || '', genre: m.genre || '' });
  }
  // a title can appear in both endpoints (their films are listed as "series" too)
  const seen = new Set();
  const sUniq = series.filter((x) => { const k = norm(x.title); if (seen.has(k)) return false; seen.add(k); return true; });
  const mUniq = movies.filter((x) => { const k = norm(x.title); if (seen.has(k)) return false; seen.add(k); return true; });

  const channels = JSON.parse(fs.readFileSync(path.join(__dirname, 'jcartoon.json'), 'utf8')).channels || [];
  const out = {
    built: new Date().toISOString(),
    note: 'jcartoon.top — مسلسلات وأفلام بجودة FULL HD 1080p. الروابط موقّعة تُطلب لحظيًا عند التشغيل.',
    series: sUniq, movies: mUniq, channels,
  };
  fs.writeFileSync(OUT, JSON.stringify(out));
  const eps = sUniq.reduce((n, x) => n + x.episodes.length, 0);
  console.log(`  مسلسلات قابلة للتشغيل: ${sUniq.length} (حلقاتها ${eps}) · أفلام: ${mUniq.length}`);
  console.log('  أمثلة:', sUniq.slice(0, 6).map((x) => `${x.title} (${x.total})`).join(' · '));

  // mirror the map used to put their 1080p copy on top of a matching Stardima movie
  const idx = JSON.parse(fs.readFileSync(path.join(__dirname, 'catalog-index.min.json'), 'utf8'));
  const ours = [];
  for (const k of ['series', 'movies']) for (const it of idx[k].items) ours.push({ slug: it[0], title: it[1], kind: k === 'movies' ? 'movie' : 'series' });
  const byN = new Map();
  for (const o of ours) if (!byN.has(norm(o.title))) byN.set(norm(o.title), o);
  const map = {};
  for (const it of [...mUniq].map((x) => ({ ...x, kind: 'movie' }))) {
    const o = byN.get(norm(it.title));
    if (o) map[o.slug] = { id: it.id, title: it.title, kind: it.kind, movieId: it.id };
  }
  fs.writeFileSync(path.join(__dirname, 'jc-map.json'), JSON.stringify({ note: 'stardima slug → jcartoon movie (exact title match)', items: map }));
  console.log(`  ربط مع أفلامنا: ${Object.keys(map).length}`);

  // same idea for series: map by exact title, then the worker can serve episode N from them
  const smap = {};
  for (const s of sUniq) {
    const o = byN.get(norm(s.title));
    if (o && o.kind === 'series') smap[o.slug] = { id: s.id, title: s.title, total: s.episodes.length };
  }
  fs.writeFileSync(path.join(__dirname, 'jc-smap.json'), JSON.stringify({ note: 'stardima series slug → jcartoon series (exact title match)', items: smap }));
  console.log(`  ربط مع مسلسلاتنا: ${Object.keys(smap).length}`);
})();
