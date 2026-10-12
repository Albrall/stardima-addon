// كرتون زمان — the same addon bundle, served outside Cloudflare.
//
// Why this exists: the video hosts (Mixdrop and the rest) answer 403 to *every*
// Cloudflare egress IP — the embed page and the video CDN alike, whatever headers
// we send. Running this identical bundle somewhere else puts nothing between you
// and those hosts, so the servers that work on the website work here too.
// Measured: Mixdrop 0/6 through Cloudflare, 6/6 from here.
//
// Deno Deploy: entrypoint deploy/deno/main.js — no build step.
import worker from '../worker-addon.js';

const PORT = Number(Deno.env.get('PORT') || 8000);

Deno.serve({ port: PORT, onListen: ({ port }) => {
  console.log(`كرتون زمان on http://0.0.0.0:${port}`);
  console.log('Manifest: /manifest.json  ·  Install page: /  ·  Health: /health');
} }, async (req) => {
  try {
    const res = await worker.fetch(req);
    const headers = new Headers(res.headers);
    headers.set('access-control-allow-origin', '*');
    // stream links are minted per request, so nothing here may be cached
    headers.set('cache-control', 'no-store');
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  } catch (e) {
    return new Response('addon error: ' + (e && e.message), { status: 500, headers: { 'access-control-allow-origin': '*' } });
  }
});
