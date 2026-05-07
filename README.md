# vtt-ui

Public search interface for streamer VOD transcripts at
[vtt-ui.pages.dev](https://vtt-ui.pages.dev). Static site deployed via
Cloudflare Pages, with Pages Functions fronting an R2 corpus and proxying
to a local GPU pipeline (separate repo) for transcribe / render / event
detection.

## Stack

- Vanilla JS + HTML in `site/index.html` (no build step)
- TypeScript Pages Functions in `site/functions/api/`
- Cloudflare R2 (`vtt-public-prod`) for clips/transcripts/events/vods indexes
- Cloudflare Pages for hosting + edge functions
- OAuth client of [laughingwhales.com](https://laughingwhales.com) for Twitch login

## Deploy

```bash
cd site
npx wrangler pages deploy . --project-name vtt-ui --commit-dirty=true
```

Requires `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` in env. The token
needs Pages write + R2 read on `vtt-public-prod`.

## Pages secrets (set via dashboard, NOT committed)

- `LW_OAUTH_CLIENT_ID` — OAuth client id registered with laughingwhales.com
- `LW_OAUTH_BASE_URL` — `https://laughingwhales.com`
- `LW_COOKIE_SECRET` — HMAC key for signed session cookies

## R2 bindings (from `site/wrangler.toml`)

- `PUBLIC_BUCKET` → `vtt-public-prod`
