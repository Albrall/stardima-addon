import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);

const stardima = require('../src/lib/stardima.js');
const hosts = require('../src/lib/hosts.js');
const unpacker = require('../src/lib/unpacker.js');

test('Arabic Title Normalization (normTitle)', () => {
  assert.equal(stardima.normTitle('أَبْطَالُ الدِّيجِيتَالِ'), 'ابطال الديجيتال');
  assert.equal(stardima.normTitle('المُحَقِّقُ كُونَان'), 'المحقق كونان');
  assert.equal(stardima.normTitle('مُغَامَرَاتٌ شَيِّقَةٌ'), 'مغامرات شيقه');
  assert.equal(stardima.normTitle('إِلَى الأَبَدِ'), 'الي الابد');
  assert.equal(stardima.normTitle('  سبيستون  '), 'سبيستون');
});

test('Arabic Collation Sorting (byTitleAr)', () => {
  const titles = ['سبيستون', 'أبطال', 'بائع الحليب', 'توم وجيري'];
  titles.sort(stardima.byTitleAr);
  assert.deepEqual(titles, ['أبطال', 'بائع الحليب', 'توم وجيري', 'سبيستون']);
});

test('Unwrap Embed URL (unwrapEmbed)', () => {
  const wrapped = 'https://strema.top/embed2/?id=https%3A%2F%2Fuqload.vc%2Fembed-6z9p5k.html';
  const unwrapped = hosts.unwrapEmbed(wrapped);
  assert.equal(unwrapped, 'https://uqload.vc/embed-6z9p5k.html');

  const direct = 'https://mixdrop.co/e/abcdef';
  assert.equal(hosts.unwrapEmbed(direct), direct);
});

test('Dean Edwards Unpacker (unpackAll without eval)', () => {
  // A standard p.a.c.k.e.r encoded snippet
  const packed = "eval(function(p,a,c,k,e,d){e=function(c){return c};if(!''.replace(/^/,String)){while(c--){d[c]=k[c]||c}k=[function(e){return d[e]}];e=function(){return'\\\\w+'};c=1};while(c--){if(k[c]){p=p.replace(new RegExp('\\\\b'+e(c)+'\\\\b','g'),k[c])}}return p}('0 1=\"2://3.4/5.6\";',7,7,'var|video_url|https|cdn|example|stream|m3u8'.split('|'),0,{}))";
  const unpacked = unpacker.unpackAll(packed);
  assert.match(unpacked, /var video_url="https:\/\/cdn\.example\/stream\.m3u8";/);

  const candidates = hosts.extractCandidates(unpacked);
  assert.equal(candidates.m3u8.length, 1);
  assert.equal(candidates.m3u8[0], 'https://cdn.example/stream.m3u8');
});

test('Worker Bundle Integration Check', async () => {
  const mod = await import('file://' + path.join(__dirname, '../worker-addon.js'));
  const worker = mod.default || mod;
  assert.equal(typeof worker.fetch, 'function');

  // Test local /health endpoint
  const req = new Request('http://localhost:7000/health');
  const res = await worker.fetch(req, {}, { waitUntil: () => {} });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.version, '3.9.0');
  assert.equal(typeof data.index.series, 'number');
  assert.ok(data.index.series > 1000);

  // Test /manifest.json catalogs and order
  const manifestReq = new Request('http://localhost:7000/manifest.json');
  const manifestRes = await worker.fetch(manifestReq, {}, { waitUntil: () => {} });
  assert.equal(manifestRes.status, 200);
  const manifest = await manifestRes.json();
  assert.equal(manifest.version, '3.9.0');
  const catalogIds = manifest.catalogs.map(c => c.id);
  assert.ok(catalogIds.includes('stardima-new'));
  assert.ok(catalogIds.includes('stardima-spacetoon'));
  assert.ok(catalogIds.includes('stardima-classic'));
  assert.equal(manifest.catalogs[0].id, 'stardima-new');
  assert.match(manifest.catalogs[0].name, /أحدث المسلسلات/);

  // Test /catalog/series/stardima-spacetoon.json
  const stReq = new Request('http://localhost:7000/catalog/series/stardima-spacetoon.json');
  const stRes = await worker.fetch(stReq, {}, { waitUntil: () => {} });
  assert.equal(stRes.status, 200);
  const stData = await stRes.json();
  assert.ok(Array.isArray(stData.metas) && stData.metas.length > 50);

  // Test /catalog/series/stardima-classic.json
  const clReq = new Request('http://localhost:7000/catalog/series/stardima-classic.json');
  const clRes = await worker.fetch(clReq, {}, { waitUntil: () => {} });
  assert.equal(clRes.status, 200);
  const clData = await clRes.json();
  assert.ok(Array.isArray(clData.metas) && clData.metas.length > 50);

  // Test /proxy domain allowlist security (block disallowed external hosts)
  const forbiddenReq = new Request('http://localhost:7000/proxy?u=' + Buffer.from('https://evil-hacker.com/malware.exe').toString('base64url'));
  const forbiddenRes = await worker.fetch(forbiddenReq, {}, { waitUntil: () => {} });
  assert.equal(forbiddenRes.status, 403);
  const forbiddenText = await forbiddenRes.text();
  assert.match(forbiddenText, /forbidden/i);
});

