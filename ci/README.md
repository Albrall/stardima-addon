# Ready-to-activate GitHub Actions

These workflows are kept here, not in `.github/workflows/`, because pushing them
requires a GitHub token with the **workflow** scope (creating/updating workflow
files is blocked for plain `repo` tokens).

To activate:

```bash
mkdir -p .github/workflows && cp ci/*.yml .github/workflows/ && git add .github && git commit -m "enable CI" && git push
```

…or copy the files into `.github/workflows/` from the GitHub web UI.

- `refresh-index.yml` — monthly: rebuilds the full library snapshot + category map
  from the site, rebuilds the Worker and redeploys it. Runs on GitHub runners,
  not Cloudflare, because Stardima rate-limits Cloudflare edge IPs.
- `watch.yml` — every 6 hours: verifies /health, catalog size and a full
  playback chain (resolve -> playlist -> segment). A failing run emails the owner.
- `keep-warm.yml` — every 10 minutes: pings the optional relay (Render) so it
  does not spin down. Needs a `RELAY_URL` secret.
