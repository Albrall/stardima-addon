// Trains a per-genre Naive Bayes classifier on the titles we could label from real
// sources (TMDB / Wikidata / AniList / bulk reference DBs), then predicts genres for
// the rest. Features: title tokens, description tokens, the site's category
// membership, and the decade. Reported quality comes from cross-validation.
const fs = require('fs');
const path = require('path');
const { normTitle } = require('./lib/stardima');

const D = __dirname;
const read = (f, dflt) => { try { return JSON.parse(fs.readFileSync(path.join(D, f), 'utf8')); } catch (e) { return dflt; } };
const titles = read('titles.json', {});
const catalog = read('catalog-index.min.json', {});
const siteGenres = read('genres.json', { labels: [], items: {} });
const base = read('our-genres.json', {});
const heuristic = read('our-genres-heuristic.json', { items: {} });
const LABELS = base.labels;

// ---------- labelled set (real genres only) ----------
const sources = [
  { name: 'tmdb', data: read('meta-tmdb-state.json', { results: {} }).results, w: 1 },
  { name: 'wikidata-join', data: read('wd-matches.json', { results: {} }).results, w: 1 },
  { name: 'bulk', data: read('bulk-matches.json', { results: {} }).results, w: 1 },
  { name: 'anilist', data: read('meta-state.json', { results: {} }).results, w: 1 },
];
const labelled = {};
for (const src of sources) {
  for (const [slug, r] of Object.entries(src.data)) {
    if (!r || !r.tags || !r.tags.length) continue;
    labelled[slug] = { tags: r.tags.filter((t) => LABELS.indexOf(t) >= 0), source: r.source || src.name, match: r.match || '', conf: r.conf || '' };
  }
}
console.log(`labelled titles: ${Object.keys(labelled).length} of ${Object.keys(titles).length}`);
const bySrc = {}; for (const r of Object.values(labelled)) bySrc[r.source] = (bySrc[r.source] || 0) + 1;
console.log('  by source:', JSON.stringify(bySrc));

// ---------- features ----------
const AR_STOP = new Set(['من','في','على','الى','إلى','عن','مع','هذا','هذه','التي','الذي','كان','كانت','يتم','كل','بعد','قبل','حيث','لكن','او','أو','ان','أن','إن','ما','لا','لم','هو','هي','هم','عندما','بين','حول','خلال','ايضا','أيضا','جدا','جداً']);
function tokenize(text, weight) {
  const out = [];
  const ar = normTitle(text || '').replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter((t) => t.length >= 3 && !AR_STOP.has(t));
  for (const t of ar) {
    out.push([t, weight]);
    if (t.length > 4 && t.startsWith('ال')) out.push([t.slice(2), weight * 0.7]);
  }
  const la = String(text || '').toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 4);
  for (const t of la) out.push(['#' + t, weight]);
  return out;
}
function featuresFor(slug) {
  const t = titles[slug] || {};
  const feats = [];
  for (const [tok, w] of tokenize(t.t, 3)) feats.push([tok, w]);
  for (const [tok, w] of tokenize(t.d, 1)) feats.push([tok, w]);
  const y = t.y || 0;
  if (y) feats.push(['DEC:' + Math.floor(y / 10) * 10, 1.5]);
  const gi = siteGenres.items[slug];
  if (gi) for (const n of String(gi).split(',')) {
    const lab = (siteGenres.labels[+n] || [])[0];
    if (lab) feats.push(['CAT:' + lab, 2]);
  }
  return feats;
}

// ---------- naive bayes (log-odds) ----------
function train(slugs) {
  const pos = {}, neg = {};
  for (const g of LABELS) { pos[g] = new Map(); neg[g] = new Map(); }
  let n = 0;
  for (const slug of slugs) {
    const r = labelled[slug]; if (!r) continue;
    const feats = featuresFor(slug);
    const tags = new Set(r.tags);
    n++;
    for (const [tok, w] of feats) {
      for (const g of LABELS) {
        const m = tags.has(g) ? pos[g] : neg[g];
        m.set(tok, (m.get(tok) || 0) + w);
      }
    }
  }
  const models = {};
  for (const g of LABELS) {
    const np = Object.keys(labelled).filter((s) => slugs.includes(s) && labelled[s].tags.includes(g)).length;
    if (np < 6) { models[g] = null; continue; }
    let sp = 0, sn = 0;
    for (const v of pos[g].values()) sp += v;
    for (const v of neg[g].values()) sn += v;
    const V = new Set([...pos[g].keys(), ...neg[g].keys()]).size || 1;
    models[g] = { pos: pos[g], neg: neg[g], sp, sn, V, prior: Math.log((np + 1) / (n - np + 1)) };
  }
  return models;
}
function score(models, slug) {
  const feats = featuresFor(slug);
  const out = {};
  for (const g of LABELS) {
    const m = models[g]; if (!m) continue;
    let s = m.prior;
    for (const [tok, w] of feats) {
      const cp = m.pos.get(tok) || 0, cn = m.neg.get(tok) || 0;
      if (!cp && !cn) continue;
      const p = (cp + 1) / (m.sp + m.V);
      const q = (cn + 1) / (m.sn + m.V);
      s += w * Math.log(p / q);
    }
    out[g] = s;
  }
  return out;
}

// ---------- cross-validation: classifier vs heuristic vs union, per genre ----------
const slugsAll = Object.keys(labelled);
const folds = 5;
const foldOf = {}; slugsAll.forEach((s, i) => { foldOf[s] = i % folds; });
const TH_MIN = 0.4, TH_MAX = 5, TH_STEP = 0.2;
const modelCfg = {};   // genre -> { mode: 'nb' | 'heur' | 'union', th }
for (const g of LABELS) modelCfg[g] = { mode: 'nb', th: 1.5 };

const heurPred = (slug, g) => {
  const raw = heuristic.items[slug];
  if (!raw) return false;
  return String(raw).split(',').map((n) => LABELS[+n]).includes(g);
};

const agg = {}; // mode -> genre -> {tp,fp,fn}
const addStat = (mode, g, tp, fp, fn) => {
  const m = agg[mode] = agg[mode] || {};
  const a = m[g] = m[g] || { tp: 0, fp: 0, fn: 0 };
  a.tp += tp; a.fp += fp; a.fn += fn;
};
for (let f = 0; f < folds; f++) {
  const trainS = slugsAll.filter((s) => foldOf[s] !== f);
  const testS = slugsAll.filter((s) => foldOf[s] === f);
  const models = train(trainS);
  const scored = testS.map((s) => ({ s, sc: score(models, s) }));
  for (const g of LABELS) {
    const gold = (s) => labelled[s].tags.includes(g);
    // 1) classifier: pick the threshold maximising F1 on this fold
    let best = { f1: -1, th: 1.5 };
    if (models[g]) {
      for (let th = TH_MIN; th <= TH_MAX; th += TH_STEP) {
        let tp = 0, fp = 0, fn = 0;
        for (const { s, sc } of scored) {
          const pred = (sc[g] || -99) >= th;
          if (pred && gold(s)) tp++; else if (pred && !gold(s)) fp++; else if (!pred && gold(s)) fn++;
        }
        const f1 = (2 * tp) / (2 * tp + fp + fn + 1e-9);
        if (f1 > best.f1) best = { f1, th };
      }
      let tp = 0, fp = 0, fn = 0;
      for (const { s, sc } of scored) {
        const pred = (sc[g] || -99) >= best.th;
        if (pred && gold(s)) tp++; else if (pred && !gold(s)) fp++; else if (!pred && gold(s)) fn++;
      }
      addStat('nb', g, tp, fp, fn);
      modelCfg[g].th = modelCfg[g].th === 1.5 ? best.th : (modelCfg[g].th + best.th) / 2;
    }
    modelCfg[g].nbF1 = best.f1;
    // 2) heuristic alone
    let tp = 0, fp = 0, fn = 0;
    for (const s of testS) { const p = heurPred(s, g); if (p && gold(s)) tp++; else if (p && !gold(s)) fp++; else if (!p && gold(s)) fn++; }
    addStat('heur', g, tp, fp, fn);
    modelCfg[g].heurF1 = (2 * tp) / (2 * tp + fp + fn + 1e-9);
    // 3) union: classifier at its best threshold OR heuristic (capped at 3 genres)
    let tp2 = 0, fp2 = 0, fn2 = 0;
    for (const { s, sc } of scored) {
      const ranked = Object.entries(sc).filter(([gg, v]) => v >= modelCfg[gg].th).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([gg]) => gg);
      const union = new Set(ranked);
      for (const gg of LABELS) if (heurPred(s, gg) && union.size < 4) union.add(gg);
      const pred = union.has(g);
      const g0 = labelled[s].tags.includes(g);
      if (pred && g0) tp2++; else if (pred && !g0) fp2++; else if (!pred && g0) fn2++;
    }
    addStat('union', g, tp2, fp2, fn2);
    modelCfg[g].unionF1 = (2 * tp2) / (2 * tp2 + fp2 + fn2 + 1e-9);
    // choose the best strategy for this genre
    const cand = [['nb', modelCfg[g].nbF1], ['heur', modelCfg[g].heurF1], ['union', modelCfg[g].unionF1]];
    cand.sort((a, b) => b[1] - a[1]);
    modelCfg[g].mode = cand[0][1] > 0.02 ? cand[0][0] : 'nb';
    modelCfg[g].chosenF1 = cand[0][1];
  }
}
const f1 = (a) => (2 * a.tp) / (2 * a.tp + a.fp + a.fn + 1e-9);
const pr = (a) => a.tp / (a.tp + a.fp + 1e-9);
const rc = (a) => a.tp / (a.tp + a.fn + 1e-9);
console.log('\n--- per-genre strategies (chosen by 5-fold CV) ---');
console.log('  genre              n     chosen   P     R     F1');
const chosenAgg = { tp: 0, fp: 0, fn: 0 };
for (const g of LABELS) {
  const n = (agg.nb[g] ? agg.nb[g].tp + agg.nb[g].fn : 0);
  if (!n) continue;
  const a = agg[modelCfg[g].mode][g];
  chosenAgg.tp += a.tp; chosenAgg.fp += a.fp; chosenAgg.fn += a.fn;
  console.log(`  ${g.padEnd(18)} ${String(n).padStart(4)} ${modelCfg[g].mode.padEnd(6)} ${(pr(a) * 100).toFixed(0).padStart(4)}% ${(rc(a) * 100).toFixed(0).padStart(4)}% ${(f1(a) * 100).toFixed(0).padStart(4)}%   (nb ${(modelCfg[g].nbF1 * 100).toFixed(0)} | heur ${(modelCfg[g].heurF1 * 100).toFixed(0)} | union ${(modelCfg[g].unionF1 * 100).toFixed(0)})`);
}
console.log(`  CHOSEN OVERALL: P=${(pr(chosenAgg) * 100).toFixed(0)}%  R=${(rc(chosenAgg) * 100).toFixed(0)}%  F1=${(f1(chosenAgg) * 100).toFixed(0)}%`);

// ---------- final model + predictions ----------
const models = train(slugsAll);
const predicted = {};
for (const slug of Object.keys(titles)) {
  if (labelled[slug]) continue;
  const sc = score(models, slug);
  const nbList = Object.entries(sc).filter(([g, v]) => modelCfg[g].mode !== 'heur' && v >= modelCfg[g].th)
    .sort((a, b) => b[1] - a[1]).slice(0, 3).map(([g]) => g);
  const set = new Set(nbList);
  for (const g of LABELS) {
    if (modelCfg[g].mode === 'heur' || modelCfg[g].mode === 'union') { if (heurPred(slug, g) && set.size < 4) set.add(g); }
  }
  if (set.size) predicted[slug] = [...set];
}
console.log(`\npredicted for ${Object.keys(predicted).length} unlabelled titles`);

// ---------- the site's own curated collections are facts, not guesses ----------
const CURATED = {
  'krton-aslamy': ['ديني وإسلامي'],
  'nynga': ['نينجا وساموراي'],
  'aflam-naorto': ['أكشن', 'نينجا وساموراي'],
  'aflam-konan': ['غموض وتحقيق'],
  'aflam-doraymon-doraemon-movie': ['خيال علمي', 'فانتازيا'],
  'aflam-harry-potter': ['فانتازيا'],
  'aflam-barby': ['رومانسي', 'فانتازيا'],
  'aflam-skoby-do-scooby-doo': ['غموض وتحقيق', 'رعب'],
  'aflam-boku-no-hero-academia': ['أكشن'],
};
const curatedTags = {};
for (const [slug, tags] of Object.entries(CURATED)) {
  const gi = siteGenres.labels.findIndex(([sl]) => sl === slug);
  if (gi < 0) continue;
  for (const [title, raw] of Object.entries(siteGenres.items || {})) {
    if ((',' + String(raw) + ',').indexOf(',' + gi + ',') < 0) continue;
    curatedTags[title] = [...new Set([...(curatedTags[title] || []), ...tags])];
  }
}
console.log(`curated site collections contribute tags to ${Object.keys(curatedTags).length} titles`);

// ---------- assemble everything ----------
const items = {}, source = {}, match = {}, confidence = {};
for (const slug of Object.keys(titles)) {
  const real = labelled[slug];
  let tags = real ? real.tags.slice() : (predicted[slug] ? predicted[slug].slice() : []);
  let src = real ? real.source : (predicted[slug] ? 'classifier' : '');
  if (!tags.length) {
    const raw = heuristic.items[slug];
    if (raw) { tags = String(raw).split(',').map((n) => LABELS[+n]).filter(Boolean); src = 'heuristic'; }
  }
  const cur = curatedTags[slug];
  if (cur && cur.length) {
    tags = [...new Set([...tags, ...cur])];
    if (!src || src === 'heuristic') src = 'site-curated';
  }
  if (!tags.length) continue;
  const idxs = [...new Set(tags.map((t) => LABELS.indexOf(t)).filter((i) => i >= 0))];
  if (!idxs.length) continue;
  items[slug] = idxs.join(',');
  source[slug] = src;
  if (real) { match[slug] = real.match; confidence[slug] = real.conf; }
}
const cov = Object.keys(items).length / Object.keys(titles).length;
const srcCount = {}; for (const v of Object.values(source)) srcCount[v] = (srcCount[v] || 0) + 1;
console.log(`coverage: ${Object.keys(items).length}/${Object.keys(titles).length} (${(cov * 100).toFixed(0)}%)`);
console.log('  by source:', JSON.stringify(srcCount));
fs.writeFileSync(path.join(D, 'classifier-model.json'), JSON.stringify({
  cfg: modelCfg, labels: LABELS, built: new Date().toISOString(),
  eval: { P: pr(chosenAgg), R: rc(chosenAgg), F1: f1(chosenAgg) },
}));
fs.writeFileSync(path.join(D, 'our-genres.json'), JSON.stringify({
  labels: LABELS, items, source, match, confidence, built: new Date().toISOString(), via: 'classifier',
}));
console.log('  wrote our-genres.json (via classifier)');
