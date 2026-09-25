// Caches title + description + year for the whole library (used by the genre
// classifier and by any future re-training).
const fs = require('fs');
const path = require('path');
const { getJson, BASE } = require('./lib/stardima');
const OUT = path.join(__dirname, 'titles.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function page(ep, p) {
  for (let a = 0; a < 4; a++) { try { return await getJson(`${BASE}/${ep}?page=${p}`); } catch (e) { await sleep(500 * (a + 1)); } }
  return null;
}
async function pool(items, worker, conc) { let i = 0; await Promise.all(Array.from({ length: conc }, async () => { while (i < items.length) await worker(items[i++]); })); }
(async () => {
  const out = {};
  for (const [ep, name] of [['mosalsalat', 'series'], ['aflam', 'movies']]) {
    const first = await page(ep, 1);
    const last = ((first && first.pagination && first.pagination.last_page) || 1);
    const pages = Array.from({ length: last }, (_, i) => i + 1);
    let done = 0;
    await pool(pages, async (p) => {
      const j = p === 1 ? first : await page(ep, p);
      for (const v of ((j && j.videos) || [])) {
        const slug = String(v.url || '').split('/').filter(Boolean).pop();
        if (!slug) continue;
        out[slug] = { t: v.title || '', d: (v.description || '').slice(0, 600), y: parseInt(v.year, 10) || 0, s: name };
      }
      if (++done % 50 === 0) process.stdout.write(`\r  ${name}: ${done}/${last} pages   `);
    }, 6);
    console.log(`\n  ${name}: ${last} pages`);
  }
  fs.writeFileSync(OUT, JSON.stringify(out));
  console.log(`  cached ${Object.keys(out).length} titles -> titles.json (${(fs.statSync(OUT).size / 1024 / 1024).toFixed(1)} MB)`);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
