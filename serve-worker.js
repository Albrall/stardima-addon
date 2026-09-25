// Serves the *production* Worker bundle over plain HTTP so it can be previewed
// (and used as a local addon) with byte-for-byte identical behaviour.
const http = require('http');
const { Readable } = require('stream');
const path = require('path');

const PORT = parseInt(process.env.PORT || '7000', 10);
const BUNDLE = path.join(__dirname, 'worker-addon.js');

(async () => {
  const mod = await import('file://' + BUNDLE);
  const worker = mod.default || mod;

  const server = http.createServer(async (req, res) => {
    try {
      const url = 'http://' + (req.headers.host || 'localhost') + req.url;
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) {
        if (typeof v === 'string') headers.set(k, v);
        else if (Array.isArray(v)) headers.set(k, v.join(', '));
      }
      const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
      const init = { method: req.method, headers };
      if (hasBody) init.body = Readable.toWeb(req);
      if (hasBody) init.duplex = 'half';
      const request = new Request(url, init);
      const ctx = { waitUntil: (p) => { Promise.resolve(p).catch(() => {}); }, passThroughOnException: () => {} };
      const resp = await worker.fetch(request, process.env, ctx);
      res.statusCode = resp.status;
      for (const [k, v] of resp.headers) {
        if (k.toLowerCase() === 'content-encoding' || k.toLowerCase() === 'content-length') continue;
        try { res.setHeader(k, v); } catch (e) { /* skip invalid */ }
      }
      if (resp.body) {
        Readable.fromWeb(resp.body).pipe(res);
      } else {
        res.end(await resp.text());
      }
    } catch (e) {
      res.statusCode = 500;
      res.setHeader('content-type', 'text/plain; charset=utf-8');
      res.end('local server error: ' + (e && e.message));
    }
  });
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Stardima addon (production worker code) on http://0.0.0.0:${PORT}`);
    console.log(`Manifest: /manifest.json  ·  Install page: /  ·  Health: /health`);
  });
})();
