// End-to-end check against a running addon: list the streams it offers for a sample
// of works, then actually pull each one and report whether bytes come back.
// Usage: node tools/live-check.js [baseUrl] [nWorks]
const BASE = process.argv[2] || 'http://127.0.0.1:7000';
const N = Number(process.argv[3] || 10);
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const census = require('./census.json');

const works = census.works.filter(w => w.kind === 'series' && w.epId).slice(0, N);

async function probeStream(s) {
  if (!s.url) return { status: 0, bytes: 0, ct: 'no-url (message entry)' };
  // direct file (dima lifeboat / jcartoon direct) or our own proxy endpoint
  const url = s.url.startsWith('http') ? s.url : BASE + s.url;
  const c = new AbortController(); const t = setTimeout(() => c.abort(), 45000);
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: '*/*', Range: 'bytes=0-400000' }, signal: c.signal, redirect: 'follow' });
    if (!r.ok && r.status !== 206) return { status: r.status, bytes: 0 };
    const ct = r.headers.get('content-type') || '';
    let bytes, detail = '';
    if (/mpegurl|m3u8/.test(ct)) {
      const txt = await r.text();
      bytes = txt.length;
      const line = txt.split(/\r?\n/).map(x => x.trim()).find(x => x && !x.startsWith('#'));
      if (line) {
        const u2 = line.startsWith('http') ? line : new URL(line, url).href;
        const r2 = await fetch(u2, { headers: { 'User-Agent': UA, Accept: '*/*', Range: 'bytes=0-200000' } });
        const b2 = r2.ok || r2.status === 206 ? (await r2.arrayBuffer()).byteLength : 0;
        bytes = b2; detail = `playlist→segment ${r2.status}`;
      }
    } else {
      bytes = (await r.arrayBuffer()).byteLength;
    }
    return { status: r.status, bytes, ct, detail };
  } catch (e) { return { status: 0, bytes: 0, err: String(e.message).slice(0, 50) }; }
  finally { clearTimeout(t); }
}

(async () => {
  let total = 0, played = 0; const perHost = {};
  for (const w of works) {
    const id = w.slug + ':' + w.epId;
    let j;
    try { j = await (await fetch(`${BASE}/stream/series/${encodeURIComponent(id)}.json`)).json(); } catch (e) { console.log('× stream request failed', id); continue; }
    const list = (j && j.streams) || [];
    console.log(`\n${w.slug}  (${list.length} stream${list.length === 1 ? '' : 's'})`);
    for (const s of list) {
      const host = (s.name || '').split(' ·')[0];
      const r = await probeStream(s);
      const good = (r.status === 200 || r.status === 206) && r.bytes > 5000;
      if (!s.url) { console.log(`   – ${(s.name + ' | ' + s.title).slice(0, 80)}`); continue; }
      total++; if (good) played++;
      perHost[host] = perHost[host] || { ok: 0, n: 0 };
      perHost[host].n++; if (good) perHost[host].ok++;
      console.log(`   ${good ? '✓' : '×'} ${s.name.padEnd(28)} ${String(r.status).padEnd(4)} ${String(r.bytes).padStart(9)}B ${r.ct || ''} ${r.detail || ''}`);
    }
  }
  console.log(`\n=== ${played}/${total} offered streams actually played ===`);
  for (const [h, v] of Object.entries(perHost)) console.log(`  ${h.padEnd(14)} ${v.ok}/${v.n}`);
})();
