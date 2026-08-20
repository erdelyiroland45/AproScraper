# Hardverapro Scraper

This folder contains a standalone Node.js scraper with no Appwrite dependency.

## Run locally

```bash
cd github-scraper
npm install
set HARDVERAPRO_URL=https://hardverapro.hu/...
node index.js
```

## GitHub Actions

The workflow in `.github/workflows/hardverapro-scrape.yml` runs every 30 minutes and publishes the latest JSON to GitHub Pages.

It:
- installs dependencies
- runs the scraper
- restores the previous `state.json` from GitHub Pages
- publishes `latest.json` and `state.json` to GitHub Pages

## Environment

- `HARDVERAPRO_URL` required
- `STATE_FILE` optional, defaults to `state.json`

## Android app URL

After GitHub Pages is enabled, the app can load:

`https://<your-username>.github.io/<your-repo-name>/latest.json`
