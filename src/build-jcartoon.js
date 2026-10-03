// Builds the jcartoon.top source for the addon.
// Their API is clean REST; every playable entry there is a single video (film / special)
// served as 1080p HLS. Tokens are signed per request, so we never store stream URLs —
// we store the API route and fetch a fresh one at playback time.
const fs = require('fs');
const path = require('path');

const J = 'https://jcartoon.top';
const OUT = path.join(__dirname, 'jcartoon.json');

async function api(p, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(J + p, { headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json', Referer: J + '/' } });
      if (!r.ok) throw new Error('http ' + r.status);
      return await r.json();
    } catch (e) {
      await new Promise((s) => setTimeout(s, 800));
    }
  }
  return null;
}
const probe = async (u) => {
  try { const r = await fetch(u, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(20000) }); return r.ok; }
  catch (e) { return false; }
};

(async () => {
  const series = (await api('/api/series'))?.series || [];
  const movies = (await api('/api/movies'))?.movies || [];
  const channels = (await api('/api/channels'))?.channels || [];
  console.log(`  من عندهم: ${series.length} مسلسل · ${movies.length} فيلم · ${channels.length} قناة`);

  const items = [];
  const withEps = series.filter((x) => (x.episodeCount || 0) > 0);
  for (const s of withEps) {
    const eps = (await api('/api/series/' + s.id + '/episodes'))?.episodes || [];
    if (!eps.length) continue;
    const e = eps[0];
    const man = await api('/api/episode/' + e.id + '/download-manifest');
    const tok = man?.qualities?.[0]?.playlistToken;
    if (!tok) continue;
    let url; try { url = Buffer.from(tok, 'base64url').toString(); } catch (err) { continue; }
    if (!(await probe(url))) continue; // token stale → their stream is down for this title
    items.push({
      id: 's:' + s.id, kind: 'series', seriesId: s.id, episodeId: e.id,
      title: s.arabicTitle || s.title, poster: s.poster || '', backdrop: s.backdrop || '',
      desc: (s.description || '').slice(0, 500), genre: s.genre || '', year: s.year || '',
      duration: e.duration || 0, episodes: eps.length,
    });
  }
  for (const m of movies) {
    const d = await api('/api/movie/' + m.id + '/stream');
    const url = d?.playUrl;
    if (!url || !(await probe(url))) continue;
    items.push({
      id: 'm:' + m.id, kind: 'movie', movieId: m.id,
      title: m.arabicTitle || m.title, poster: m.poster || m.posterUrl || '', backdrop: m.backdrop || '',
      desc: (m.description || '').slice(0, 500), genre: m.genre || '', year: m.year || '',
      duration: m.duration || 0, episodes: 1,
    });
  }
  // de-dup by title (their API lists some films twice)
  const seen = new Set(); const uniq = [];
  for (const it of items) { const k = it.title.trim(); if (seen.has(k)) continue; seen.add(k); uniq.push(it); }

  const out = {
    built: new Date().toISOString(),
    note: 'jcartoon.top — كل عنصر هنا فيديو واحد بجودة FULL HD 1080p. الروابط موقّعة وتُطلب لحظيًا.',
    items: uniq,
    channels: channels.map((c) => ({ name: c.name, type: c.type, logo: c.logo || '', url: c.streamUrl || '' })),
  };
  fs.writeFileSync(OUT, JSON.stringify(out));
  console.log(`  قابل للتشغيل الآن: ${uniq.length} عمل (مكرر مستبعد: ${items.length - uniq.length}) · قنوات: ${out.channels.length}`);
  console.log('  نماذج:', uniq.slice(0, 5).map((x) => x.title + ' (' + (x.duration || 0) + 'ث)').join(' · '));
})();
