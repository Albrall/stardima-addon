// Builds the category (genre) map for the embedded index: one pass over every
// site category for both sections, producing slug -> label + slug -> items.
const { getJson, getHtml, BASE } = require('./lib/stardima');
const fs = require('fs');
const path = require('path');

const CONC = 4;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function slugFromUrl(u) {
  if (!u) return '';
  const p = String(u).split('/').filter(Boolean);
  return p[p.length - 1] || '';
}
async function pool(items, worker, conc) {
  let i = 0; const out = [];
  const run = async () => {
    while (i < items.length) {
      const k = i++;
      try { out[k] = await worker(items[k]); } catch (e) { out[k] = null; }
    }
  };
  await Promise.all(Array.from({ length: conc }, run));
  return out;
}
async function getPages(ep, cat, page) {
  const q = `/mosalsalat` && '';
  const url = `${BASE}/${ep}?page=${page}&category=${cat}`;
  for (let attempt = 0; attempt < 4; attempt++) {
    try { return await getJson(url); }
    catch (e) { await sleep(700 * (attempt + 1)); }
  }
  return null;
}

(async () => {
  const html = await getHtml(BASE + '/mosalsalat');
  const labels = [];
  const re = /for="category-([a-z0-9-]+)"[\s\S]{0,200}?<\/span>([^<]{1,60})<\/label>/g;
  let m;
  while ((m = re.exec(html))) if (m[1] !== 'all') labels.push([m[1], m[2].trim()]);
  console.log('categories:', labels.length);

  // 1) probe page counts per section
  const probes = [];
  for (const [slug] of labels) for (const ep of ['mosalsalat', 'aflam']) probes.push({ slug, ep });
  const probeRes = await pool(probes, async (p) => {
    const j = await getPages(p.ep, p.slug, 1);
    return { ...p, last: ((j && j.pagination && j.pagination.last_page) || 1), rows: ((j && j.videos) || []).length };
  }, CONC);
  const jobs = probeRes.filter(Boolean);
  const totalPages = jobs.reduce((s, j) => s + j.last, 0);
  console.log('page jobs needed:', jobs.length, '| total pages:', totalPages);

  // 2) walk every page
  const items = {};   // slug -> Set(category index)
  const counts = {};  // category -> n
  let done = 0;
  const all = [];
  for (const j of jobs) for (let p = 1; p <= j.last; p++) all.push({ ...j, page: p });
  await pool(all, async (t) => {
    const j = await getPages(t.ep, t.slug, t.page);
    const vids = (j && j.videos) || [];
    const gi = labels.findIndex(([s]) => s === t.slug);
    for (const v of vids) {
      const slug = slugFromUrl(v.url);
      if (!slug) continue;
      (items[slug] = items[slug] || new Set()).add(gi);
      counts[t.slug] = (counts[t.slug] || 0) + 1;
    }
    done++;
    if (done % 100 === 0) console.log('  pages done:', done, '/', all.length);
  }, CONC);

  const compact = {};
  for (const [slug, set] of Object.entries(items)) compact[slug] = [...set].sort((a, b) => a - b).join(',');
  const out = { labels, items: compact, counts, built: new Date().toISOString() };
  const p = path.join(__dirname, 'genres.json');
  fs.writeFileSync(p, JSON.stringify(out));
  console.log('genres written:', p, '| titles tagged:', Object.keys(compact).length, '| size:', (fs.statSync(p).size / 1024).toFixed(0) + 'KB');
  console.log('per category:', Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, v]) => k + ':' + v).join(' '));
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
