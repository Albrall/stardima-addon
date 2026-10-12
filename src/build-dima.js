#!/usr/bin/env node
// Builds src/dima.json — a third, *direct-link* source for the day the embedded
// hosts stop answering. dima-toon.com is WordPress, so the REST API hands us the
// episode list and every episode's own MP4 (= no resolution step, no Cloudflare
// in the media path, CORS "*", range requests honoured).
//
// Output shape (kept small: episode numbers only, filenames follow one pattern):
//   { base, series: [{ n, parts: [{ p, f, e: [..], x: {"37":"name.mp4"} }] }], map: { "<slug>": i } }
//
// Run: node src/build-dima.js
const fs = require('fs');
const path = require('path');
const ROOT = __dirname;

const API = 'https://www.dima-toon.com/wp-json/wp/v2/cartoon-episode';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const CONC = parseInt(process.env.CONC || '6', 10);

const AR = /[\u0621-\u064A0-9]/;
function norm(s) {
  return (s || '')
    .replace(/[إأآا]/g, 'ا').replace(/[ىي]/g, 'ي').replace(/ة/g, 'ه')
    .replace(/[ؤ]/g, 'و').replace(/[ئ]/g, 'ي')
    .replace(/[\u064B-\u0652\u0640]/g, '')
    .replace(/[^\w\s\u0621-\u064A]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
const WORDS = { 'الأول': 1, 'الاول': 1, 'الثاني': 2, 'الثانى': 2, 'الثالث': 3, 'الرابع': 4, 'الخامس': 5, 'السادس': 6, 'السابع': 7, 'الثامن': 8, 'التاسع': 9, 'العاشر': 10 };
const NUMERALS = { '٠': 0, '١': 1, '٢': 2, '٣': 3, '٤': 4, '٥': 5, '٦': 6, '٧': 7, '٨': 8, '٩': 9 };
function arabicNum(s) {
  let out = 0;
  for (const ch of String(s)) if (NUMERALS[ch] != null) out = out * 10 + NUMERALS[ch];
  return out || null;
}
// title -> { base, part, episode }
function parseTitle(t) {
  let s = String(t || '').replace(/[\u200b\u200c\u200d]/g, '').replace(/\s+/g, ' ').trim();
  let ep = null, part = 1;
  s = s.replace(/(?:الحلقة|حلقة)\s*([\d٠-٩]+)/, (m, d) => { ep = parseInt(d, 10) || arabicNum(d); return ' '; });
  s = s.replace(/(?:الجزء|الموسم)\s*([\d٠-٩]+|[الأولالثانيعشرابجدسهزو]+)/, (m, d) => {
    part = parseInt(d, 10) || arabicNum(d) || WORDS[d] || 1; return ' ';
  });
  s = norm(s);
  if (ep == null) {
    const m = s.match(/(?:^|\s)(\d{1,4})$/);
    if (m) { ep = parseInt(m[1], 10); s = s.slice(0, m.index).trim(); }
  }
  return { base: s.replace(/\s+/g, ' ').trim(), part, ep };
}
async function jget(u, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(u, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
      if (!r.ok) throw new Error('http ' + r.status);
      return await r.json();
    } catch (e) { if (i === tries - 1) throw e; await new Promise((r) => setTimeout(r, 1500 * (i + 1))); }
  }
}
(async () => {
  // 1) how many pages?
  let pages = 1;
  try {
    // the header counts PAGES at this page size — ask with the size we will sweep with
    const head = await fetch(API + '?per_page=100&_fields=id', { headers: { 'User-Agent': UA } });
    pages = parseInt(head.headers.get('x-wp-totalpages') || '1', 10);
  } catch (e) { /* fall through */ }
  console.log('pages:', pages);

  const raw = new Array(pages + 1).fill(null);
  let cursor = 1;
  async function worker() {
    for (;;) {
      const p = cursor++;
      if (p > pages) return;
      for (let a = 0; a < 3; a++) {
        try { raw[p] = await jget(`${API}?per_page=100&page=${p}&_fields=id,title,content`); break; }
        catch (e) { if (a === 2) raw[p] = []; await new Promise((r) => setTimeout(r, 1200)); }
      }
      if (p % 10 === 0) process.stdout.write(`\r  fetched ${p}/${pages}   `);
    }
  }
  await Promise.all(Array.from({ length: CONC }, worker));
  process.stdout.write(`\r  fetched ${pages}/${pages}\n`);

  // 2) collect episodes
  const eps = [];
  for (const page of raw) {
    if (!Array.isArray(page)) continue;
    for (const it of page) {
      const html = (it.content && it.content.rendered) || '';
      const m = html.match(/<source[^>]+src="([^"]+)"/i) || html.match(/src="(https?:\/\/[^"]+\.mp4[^"]*)"/i);
      if (!m) continue;
      const title = String((it.title && it.title.rendered) || '').replace(/<[^>]+>/g, '');
      const url = m[1].replace(/\\\//g, '/');
      const p = parseTitle(title);
      if (!p.base || p.ep == null) continue;
      eps.push({ ...p, url });
    }
  }
  console.log('episodes with a direct mp4:', eps.length);

  // 3) group: base -> part -> { folder, file pattern, episodes }
  const byBase = new Map();
  for (const e of eps) {
    const u = new URL(e.url);
    const seg = u.pathname.split('/').filter(Boolean);
    const file = seg.pop();
    const folder = seg.pop();
    const stem = file.replace(/\.mp4$/i, '');
    const suffix = '-' + e.ep;
    const pattern = stem.endsWith(suffix) ? stem.slice(0, -suffix.length) : null;
    if (!byBase.has(e.base)) byBase.set(e.base, new Map());
    const parts = byBase.get(e.base);
    if (!parts.has(e.part)) parts.set(e.part, { f: folder, stem: pattern || stem, nums: new Set(), x: {} });
    const P = parts.get(e.part);
    if (pattern && pattern !== P.stem) { /* mixed stems: keep the folder, record exceptions */ }
    P.nums.add(e.ep);
    const expected = `${P.stem}-${e.ep}.mp4`;
    if (file !== expected) P.x[e.ep] = file;
    if (!P.baseUrl) P.baseUrl = `https://${u.host}/${seg.concat(folder).join('/')}/`;
  }

  // 3b) verify every file with a HEAD. Cheap (parallel, no body) and it means the
  // addon never hands the player a link that answers 404 — the one thing you must
  // not be able to do is tap something that is not there.
  const jobs = [];
  for (const [base, parts] of byBase) for (const [p, P] of parts) for (const n of P.nums) {
    const file = P.x[n] || `${P.stem || P.f}-${n}.mp4`;
    jobs.push({ base, p, n, url: `${P.baseUrl}${file}` });
  }
  console.log('verifying', jobs.length, 'files …');
  const dead = new Set();
  const BATCH = 150;
  for (let i = 0; i < jobs.length; i += BATCH) {
    const slice = jobs.slice(i, i + BATCH);
    const res = await Promise.all(slice.map(async (job) => {
      for (let a = 0; a < 2; a++) {
        try {
          const ctrl = new AbortController();
          const to = setTimeout(() => ctrl.abort(), 20000);
          const r = await fetch(job.url, { method: 'HEAD', headers: { 'User-Agent': UA }, signal: ctrl.signal });
          clearTimeout(to);
          if (r.ok) return null;
          if (r.status === 405 || r.status === 403) return null; // exists, HEAD not allowed
          if (a === 1) return job;
        } catch (e) { if (a === 1) return job; }
        await new Promise((r) => setTimeout(r, 800));
      }
      return job;
    }));
    for (const d of res) if (d) dead.add(d.base + '|' + d.p + '|' + d.n);
    process.stdout.write(`\r  verified ${Math.min(i + BATCH, jobs.length)}/${jobs.length} · broken ${dead.size}   `);
  }
  process.stdout.write('\n');
  for (const [base, parts] of byBase) for (const [p, P] of parts) {
    for (const n of [...P.nums]) if (dead.has(base + '|' + p + '|' + n)) { P.nums.delete(n); delete P.x[n]; }
  }

  const series = [];
  for (const [base, parts] of byBase) {
    const list = [...parts.entries()].sort((a, b) => a[0] - b[0]).map(([p, P]) => ({
      p,
      f: P.f,
      b: P.baseUrl,
      e: [...P.nums].sort((a, b) => a - b),
      ...(Object.keys(P.x).length ? { x: P.x } : {}),
    }));
    const count = list.reduce((n, p) => n + p.e.length, 0);
    if (count < 2) continue; // a stray episode is not a series
    series.push({ n: base, parts: list });
  }
  console.log('series groups:', series.length, '| episodes kept:', series.reduce((n, s) => n + s.parts.reduce((m, p) => m + p.e.length, 0), 0));

  // 4) match against our own catalogue (title only — the season/part pairing happens at runtime)
  const idx = JSON.parse(fs.readFileSync(path.join(ROOT, 'catalog-index.min.json'), 'utf8'));
  const ours = [];
  for (const it of (idx.series.items || [])) ours.push({ slug: it[0], title: it[1] });
  const normTitle = (t) => norm(t).replace(/^(ال|al)\s*/, '').replace(/\s+/g, ' ').trim();
  const index = new Map();
  series.forEach((s, i) => {
    const key = normTitle(s.n).replace(/^(ال)/, '');
    index.set(key, i);
    const bare = key.replace(/\b(الجزء|الموسم)\b.*$/, '').trim();
    if (!index.has(bare)) index.set(bare, i);
  });
  const map = {};
  let matched = 0;
  for (const w of ours) {
    const key = normTitle(w.title);
    let hit = index.get(key);
    if (hit == null) hit = index.get(key.replace(/\s*\d+$/, '').trim());
    if (hit == null) { // contains-match, but only when one candidate exists
      const cands = [];
      for (const [k, i] of index) if (k && (k.startsWith(key + ' ') || key.startsWith(k + ' '))) cands.push(i);
      if (cands.length === 1) hit = cands[0];
    }
    if (hit != null) { map[w.slug] = hit; matched++; }
  }
  console.log('our series matched to a direct copy:', matched, 'of', ours.length);

  const out = { built: new Date().toISOString(), base: 'https://site.word.tn/videos/', series, map };
  fs.writeFileSync(path.join(ROOT, 'dima.json'), JSON.stringify(out));
  const kb = (fs.statSync(path.join(ROOT, 'dima.json')).size / 1024).toFixed(0);
  console.log('wrote src/dima.json ·', kb, 'KB');
})();
