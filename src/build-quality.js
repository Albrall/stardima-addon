// Measures the REAL quality of every title: resolves the top server of the first
// episode (or the movie itself) and reads the master playlist's best rendition.
// Resumable: keeps src/quality-state.json so a killed run continues where it stopped.
const fs = require('fs');
const path = require('path');
const { getServers, getMovieServers, hostRank } = require('./lib/resolver');
const { resolveHost } = require('./lib/hosts');

const SRC = __dirname;
const STATE = path.join(SRC, 'quality-state.json');
const OUT = path.join(SRC, 'quality.json');
const CONC = 6;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function bestRendition(text) {
  const lines = String(text).split(/\r?\n/);
  let best = null;
  for (let i = 0; i < lines.length; i++) {
    const m = /#EXT-X-STREAM-INF:([^\n]*)/.exec(lines[i]);
    if (!m) continue;
    const res = /RESOLUTION=(\d+)x(\d+)/.exec(m[1]);
    const bw = /BANDWIDTH=(\d+)/.exec(m[1]);
    const h = res ? Number(res[2]) : 0;
    const kbps = bw ? Math.round(Number(bw[1]) / 1000) : 0;
    if (!best || h > best.height || (h === best.height && kbps > best.kbps)) best = { width: res ? Number(res[1]) : 0, height: h, kbps };
  }
  return best;
}

async function measure(title, key) {
  let links;
  try {
    links = title.s === 'series' ? await getServers(firstEpisodeOf(title)) : await getMovieServers(title.slug);
  } catch (e) { return { err: 'links' }; }
  if (!links || links.blocked || !links.servers || !links.servers.length) return { err: 'blocked' };
  const servers = links.servers.slice().sort((a, b) => hostRank(a) - hostRank(b));
  let out = null;
  for (const srv of servers.slice(0, 2)) {   // take the best of the top two servers
    if (!/^https?:/i.test(srv.embedUrl || '')) continue;
    let r;
    try { r = await resolveHost(srv.embedUrl); } catch (e) { continue; }
    if (!r || !r.url) continue;
    let text = '';
    try { text = await (await fetch(r.url, { headers: { 'User-Agent': 'Mozilla/5.0' } })).text(); } catch (e) { text = ''; }
    const best = bestRendition(text);
    const cand = { host: srv.name, type: r.type, height: best ? best.height : 0, kbps: best ? best.kbps : 0 };
    if (!out || cand.height > out.height || (cand.height === out.height && cand.kbps > out.kbps)) out = cand;
    if (out && out.height >= 1080) break;    // nothing better to look for
  }
  return out || { err: 'resolve' };
}

// series: need an episode id — the catalogue index only has slugs, so fetch the meta once
let META = null;
function firstEpisodeOf(title) {
  const m = META[title.slug];
  return m || null;
}

(async () => {
  const titles = JSON.parse(fs.readFileSync(path.join(SRC, 'titles.json'), 'utf8'));
  const index = JSON.parse(fs.readFileSync(path.join(SRC, 'catalog-index.min.json'), 'utf8'));
  const state = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, 'utf8')) : { done: {}, meta: {} };
  META = state.meta || {};

  const rows = [];
  for (const sec of ['series', 'movies']) {
    for (const it of index[sec].items) rows.push({ sec, kind: sec === 'series' ? 'series' : 'movie', slug: it[0], title: it[1] });
  }
  const CAP = Number(process.env.CAP || 0); // 0 = no cap; used to get a bounded sample fast
  let todo = rows.filter((r) => {
    const d = state.done[r.slug];
    if (!d) return true;
    if (d.err && (d.tries || 1) < 2) { d.tries = (d.tries || 1) + 1; return true; } // one retry for transient failures
    return false;
  });
  if (CAP) todo = todo.filter((r, i) => i % Math.max(1, Math.floor(rows.length / CAP)) === 0).slice(0, CAP);
  console.log(`  total ${rows.length} · done ${rows.length - todo.length} · left ${todo.length}`);

  let i = 0;
  async function worker(n) {
    while (i < todo.length) {
      const r = todo[i++];
      if (r.kind === 'series' && !META[r.slug]) {
        try {
          const { getSeriesMeta } = require('./lib/stardima');
          const m = await getSeriesMeta(r.slug);
          const v = (m && m.videos) || [];
          if (v.length) META[r.slug] = v[0].episodeId || String(v[0].id).split(':').pop();
        } catch (e) { /* leave undefined */ }
      }
      let res;
      try { res = await measure({ slug: r.slug, s: r.kind }, r.slug); } catch (e) { res = { err: 'throw' }; }
      state.done[r.slug] = res;
      if ((i & 7) === 0 || i === todo.length) {
        fs.writeFileSync(STATE, JSON.stringify(state));
        console.log(`   ...${i}/${todo.length}  ${r.title.slice(0, 24)} → ${res.err ? 'فشل:' + res.err : (res.height || '?') + 'p ' + (res.kbps || '') + 'kbps ' + (res.host || '')}`);
      }
      await sleep(120);
    }
  }
  await Promise.all(Array.from({ length: CONC }, (_, n) => worker(n)));
  fs.writeFileSync(STATE, JSON.stringify(state));

  const out = {};
  const dist = {};
  for (const [slug, v] of Object.entries(state.done)) {
    if (v && v.height) { out[slug] = { h: v.height, k: v.kbps || 0, host: v.host || '' }; dist[v.height] = (dist[v.height] || 0) + 1; }
  }
  fs.writeFileSync(OUT, JSON.stringify({ note: 'best rendition actually served by the top working server (measured, not advertised)', measured: Object.keys(out).length, items: out }));
  console.log('  measured:', Object.keys(out).length, '| توزيع الجودات:', JSON.stringify(dist));
  const sizes = Object.values(out).map((x) => x.h).filter(Boolean);
  if (sizes.length) console.log('  أعلى:', Math.max(...sizes) + 'p');
})();
