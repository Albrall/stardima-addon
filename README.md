# Stardima Add-on (Stremio / Nuvio) — v3.0.0

Add-on exposes the full Stardima library (Arabic-dubbed/subbed anime & cartoons) to
Stremio and Nuvio: browse, search, episode lists and playable streams.

**Live Worker:** `https://stardima-proxy.ingots-18joist.workers.dev/manifest.json`

## What it does

| Resource | Behaviour |
| --- | --- |
| `manifest.json` | 10 catalogs: `stardima-s1..s6` (series) + `stardima-m1..m4` (movies), each declaring the `search` extra |
| `catalog/{type}/{id}` | Alphabetical (Arabic collation) slice of an embedded index of the whole library — 2257 series + 1597 movies, 450 items per catalog |
| `catalog/{type}/{id}/search=X` | Live site search, **all result pages**, single-episode hits removed, sorted A→Y |
| `meta/{type}/{id}` | Series: seasons/episodes (e.g. المحقق كونان = 698 episodes). Movie: poster/description |
| `stream/{type}/{id}` | One stream per upstream server, **health-probed and ordered** so a working host comes first (Uqload/Mixdrop reachable from the edge; Goodstream/Savefiles/Streamhg 404, Lulustream 403) |
| `proxy/embed?u=` | Resolves the host embed **fresh at playback time** (upstream m3u8 tokens are short-lived), rewrites playlists so every URI routes back through the Worker |
| `proxy?u=&r=` | Streams playlists/segments/MP4 with the right Referer; supports `Range` (seeking) |

Ids are canonical: `stardima:{slug}` for titles and `stardima:{slug}:{episodeId}` for
episodes, matching `idPrefixes` in the manifest.

## Freshness

The catalog index is embedded at build time; every request also merges the three
newest listing pages live (cached 15 min), so new releases land in their correct
alphabetical position automatically.

| Change on the site | Visible in Nuvio |
| --- | --- |
| New title | ≤ 15 minutes |
| New episode of a known title | ≤ 30 minutes (meta cache) |
| Stream servers for an episode | instantly (resolved on play, cached 10 min) |
| Whole-library snapshot | rebuild `catalog-index.min.json` (below) and redeploy |

## Layout

```
src/
  worker-router.js     Cloudflare Worker routes (the live add-on)
  index.js             Node/Express HTTP server (fallback deployment)
  lib/stardima.js      site API: listings, search, meta, episode links, collation
  lib/resolver.js      episode/movie -> server list, health-ordered
  lib/hosts.js         host embed -> m3u8/mp4 (Dean Edwards unpacker, no eval)
  lib/unpacker.js      eval-free p.a.c.k.e.r. decoder (Workers forbid eval)
  build-index.js       fetches every listing page -> catalog-index.json
  build-worker.js      bundles src -> ../worker-addon.js and injects the index
  build-bundle.js      bundles src -> ../index.js (single-file Node server)
worker-addon.js        generated Worker module (what is deployed)
index.js               generated Node bundle
```

## Build & deploy

```bash
cd src
npm install                       # no runtime deps; build only
node build-index.js               # full-library snapshot (run from a non-edge IP)
node build-worker.js              # -> ../worker-addon.js
node build-bundle.js              # -> ../index.js
```

Deploy the Worker (script name `stardima-proxy`):

```bash
curl -X PUT "$CF_API/accounts/$CF_ACCOUNT/workers/scripts/stardima-proxy" \
  -H "Authorization: Bearer $CF_TOKEN" \
  -F 'metadata={"main_module":"worker-addon.js","compatibility_date":"2024-09-01"};type=application/json' \
  -F "worker-addon.js=@worker-addon.js;type=application/javascript+module"
```

## Notes / constraints learned the hard way

- Stardima rate-limits Cloudflare edge IPs after ~50 listing pages, which is why the
  library is an embedded snapshot plus a live merge of the newest pages — not a
  150-page fetch per request.
- Nuvio loads **one** catalog response and scrolls locally (it does not send `skip`
  while browsing), and it sends search as a **path** segment
  (`/catalog/series/stardima-s1/search=ناروتو.json`), not a query string.
- Workers forbid `eval`/`new Function`, so the packed host players are decoded by
  `lib/unpacker.js`.
- ~82% of posters are TMDB URLs; the rest are site-relative and resolve under
  `{base}/storage/`. Both forms are absolutised before they reach the client.
