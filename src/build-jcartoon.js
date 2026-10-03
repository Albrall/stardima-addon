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

  // maps are produced by build-jc-match.js (stricter + fuzzy title matching)
})();
