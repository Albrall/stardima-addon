# ElfHosted deployment and application notes

## Project summary

**كرتون زمان (Krtoon Zaman)** is an Arabic-first Stremio/Nuvio addon for dubbed and subtitled cartoons and anime. It provides catalogs, Arabic metadata, episode lists, direct HTTP/HLS streams, host health checks, and daily semantic recommendations.

Current public instance: `https://krtoonzaman.albranmaze7.workers.dev`

## Why ElfHosted

The Cloudflare instance remains the production fallback. An ElfHosted public instance would provide a conventional long-running container and room for a later, optional persistence layer for recommendation history and user-authorized Trakt/Simkl preferences. The first ElfHosted release does not require a database, Redis, debrid service, or secrets.

## Container contract

- Image build: repository-root `Dockerfile`
- Runtime: Node.js 20
- Listen address: `0.0.0.0`
- Port: `PORT` environment variable, default `8000`
- Health endpoint: `GET /health`
- Manifest: `GET /manifest.json`
- Persistent volume: not required for the initial release
- Required secrets: none
- Architecture: stateless, horizontally replicable

Build and test:

```bash
docker build -t krtoon-zaman .
docker run --rm -p 8000:8000 --name krtoon-zaman krtoon-zaman
ADDON_URL=http://127.0.0.1:8000 npm run smoke
```

## Expected traffic and media path

Catalog, metadata, stream-resolution, and health requests reach the addon. Whenever an upstream permits direct playback, media bytes travel directly from the upstream host to the user's player. A Cloudflare-style relay endpoint exists only as a labeled fallback for hosts that require it. ElfHosted may disable or rate-limit relay traffic if its policy requires this; the addon can be configured to remain direct-only for an ElfHosted deployment.

## Safety and operations

- No credentials are committed or required at runtime.
- Broken hosts are hidden or clearly unverified; a stream is marked working only after a byte probe.
- The addon does not download, seed, transcode, or permanently store media.
- `/health` exposes application and upstream state without secrets.
- The container runs as the unprivileged `node` user.
- Cloudflare remains live during evaluation and can serve as immediate rollback.

## Proposed rollout

1. ElfHosted builds a staging instance from the public repository.
2. Validate manifest, both daily catalogs, representative metadata, and representative playback.
3. Run staging alongside Cloudflare for at least seven days.
4. Publish the ElfHosted URL as an optional second instance.
5. Keep Cloudflare as fallback until reliability and policy fit are confirmed.

## Suggested Discord application message

> Hi ElfHosted team. I maintain **Krtoon Zaman**, an Arabic-first open-source Stremio/Nuvio addon for dubbed/subtitled cartoons and anime. It currently runs publicly on Cloudflare Workers and provides Arabic catalogs, metadata, episode mapping, direct HTTP/HLS streams, host health checks, and semantic daily recommendations. We would like to keep Cloudflare live while trialing a free public ElfHosted instance. The repository includes a stateless Node 20 Docker image, `/health`, no required secrets, and a smoke test. No database is required initially. We are happy to comply with rate limits and to make the ElfHosted deployment direct-only if proxy traffic is not acceptable. Could you review the repository and advise whether the addon fits your public-hosting and acceptable-use policies?

Before sending, append the public GitHub repository URL.
