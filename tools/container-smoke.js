// Smoke-test any running container/instance.
// Usage: ADDON_URL=http://127.0.0.1:8000 npm run smoke
const base = (process.env.ADDON_URL || 'http://127.0.0.1:8000').replace(/\/$/, '');

(async () => {
  const health = await fetch(base + '/health');
  if (!health.ok) throw new Error('health returned HTTP ' + health.status);
  const h = await health.json();
  if (!h.ok) throw new Error('upstream health failed: ' + JSON.stringify(h.site || h));

  const manifest = await fetch(base + '/manifest.json');
  if (!manifest.ok) throw new Error('manifest returned HTTP ' + manifest.status);
  const m = await manifest.json();
  if (!m.id || !Array.isArray(m.catalogs) || !m.catalogs.length) throw new Error('invalid manifest');

  for (const [type, id] of [['series', 'stardima-daily'], ['movie', 'stardima-daily-movies']]) {
    const r = await fetch(`${base}/catalog/${type}/${id}.json`);
    if (!r.ok) throw new Error(`${id} returned HTTP ${r.status}`);
    const j = await r.json();
    if (!Array.isArray(j.metas) || !j.metas.length) throw new Error(`${id} is empty`);
  }
  console.log(`OK ${m.name} v${m.version}: health, manifest, and daily catalogs passed`);
})().catch((e) => { console.error(e); process.exit(1); });
