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
| `catalog/{type}/{id}/genre=X` | Filter by one of the site's 36 categories (genres). Arabic letters are normalised, so `أنمي` also matches the site's `انمي`. Composable with `search` and `skip` |
| `catalog/{type}/stardima-new[-movies]` | "أحدث المسلسلات / أحدث الأفلام" shelves — newest first (site order, merged live) |
| `health` | Diagnostics: site reachable?, index size + build date, cache breakdown |
| `health?deep=1` | Runs the full self-check (site + catalog + resolve → playlist → segment) and returns the result |
| `alert-test` | Sends a test alert (opens/comments a GitHub issue, which emails the owner) |
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

## Genres

Two layers, merged into a single 59-entry filter:

1. **The site's own categories** — `build-genres.js` walks every category page
   (~133 pages) and stores slug → category indices. 36 categories, instant and offline,
   including hand-curated collections (Ben 10, MBC3, أفلام كونان, دورايمون, هاري بوتر…).
2. **Our derived tags** — built by a three-step pipeline that ends in a trained model:

   - `build-tmdb.js`      per-title TMDB search (public pages, Arabic search) -> official genres
   - `build-wikidata.js`  bulk SPARQL label join for Arabic titles, filtered to work types
   - `build-bulk.js`      downloads reference DBs once (AniList 5000 anime incl. Arabic
                          synonyms, TVMaze 80710 shows) and matches locally
   - `train-genres.js`    trains a per-genre Naive Bayes on the 1209 titles that got real
                          labels (title + description tokens, site categories, decade),
                          picks per-genre between classifier / keyword rules / union by
                          5-fold CV, then predicts the rest and adds the site's curated
                          collections as facts

   Measured on held-out folds: precision ~70%, recall ~54%, coverage 98% of the library.
   22 semantic genres + 2 date tags:

   `أكشن مغامرة كوميدي دراما خيال علمي فانتازيا غموض وتحقيق رعب رياضة مدرسي موسيقي
   طبخ حيوانات فضاء روبوتات قراصنة نينجا وساموراي سيارات ديني وإسلامي رومانسي تاريخي
   بنات السحر` + `كلاسيكي (قبل 2000)` + `جديد (2020+)`

Where a name exists in both layers (e.g. `أكشن`) one option matches the **union** of both,
so nothing is lost. `meta.genres` per title returns ours first, then theirs.

Honest quality of the derived tags (measured, not claimed): covers **73%** of the 3854
titles; against the site's hand-curated collections it recalls 100% of `أكشن`, `نينجا`
and `كرتون إسلامي`. It is a heuristic, so tag the exceptions as expected: titles with no
synopsis keyword (e.g. some raw romanised rows) can end up untagged, and a few titles
land in a neighbouring genre. `our-genres-report.txt` holds samples per genre.

## Alerts

`selfCheck()` verifies the upstream site, the embedded catalog and a real playback
chain (resolve → playlist → first segment). On failure it opens/comments a GitHub
issue (which emails the owner + is readable on the phone). It runs:

- on Worker cron (if your account accepts cron registration),
- opportunistically on any addon request, at most once every 6 hours,
- manually via `/alert-test`.

ntfy.sh is kept as a secondary channel but is unreachable from Cloudflare (522).

## Layout

```
src/
  worker-router.js     Cloudflare Worker routes (the live add-on)
  index.js             Node/Express HTTP server (fallback deployment)
  lib/stardima.js      site API: listings, search, meta, episode links, collation
  lib/resolver.js      episode/movie -> server list, health-ordered
  lib/hosts.js         host embed -> m3u8/mp4 (Dean Edwards unpacker, no eval)
  lib/unpacker.js      eval-free p.a.c.k.e.r. decoder (Workers forbid eval)
  build-index.js       fetches every listing page -> catalog-index.json (+ compact copy)
  build-genres.js      walks every category page -> genres.json (slug -> categories)
  build-ours.js        classifies the library -> our-genres.json (our semantic genres)
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
- **Only uqload is playable from a Cloudflare Worker** (measured 2026-09). Mixdrop and
  Lulustream hand out IP-bound tokens and 403 their CDN from Cloudflare *and* from
  Render; savefiles serves a JS challenge; streamhg/goodstream hide the stream behind
  obfuscated JWPlayer bootstrap code. `uqload` therefore leads the stream list, and the
  others are labelled "قد لا يعمل من السحابة" so a failed server is not a mystery.
- A Render relay was built and tested to work around that; it resolved and streamed
  uqload fine but could not resolve the blocked hosts either, so it was removed —
  no benefit, only cold starts.
- Cloudflare's API rejected cron-trigger registration for this script, hence the
  opportunistic 6-hourly self-check.
- Per-episode thumbnails are not published by the site (only series posters and an
  og:image on each /play page), so episode rows show title + number only.
