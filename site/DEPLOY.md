# Deploy

## How vtt-ui ships

This Pages project must be **Git-integrated** so `git push origin main` triggers a
production build. The Cloudflare Pages dashboard shows a GitHub-connected project
with `deployment_trigger.type: "github:push"` on the latest deployment. Direct
uploads (`wrangler pages deploy`) should only happen as a fallback.

## Why this file exists (the regression)

On 2026-05-06 the project was created via `wrangler pages deploy`, which makes it
a **Direct Upload** project. Cloudflare does not allow switching a Direct Upload
project to Git integration later — confirmed in their docs and reproduced via the
API (`POST /pages/projects` with a `source` block returns
`8000011: There is an internal issue with your Cloudflare Pages Git installation`
because the Cloudflare GitHub App was never installed on the account either).

The only fix is: delete the project and recreate it with Git integration from the
dashboard. The R2 buckets (`vtt-public-prod`, `vtt-data-prod`) are independent of
the Pages project — deleting `vtt-ui` does not touch them; the binding declared
in `wrangler.toml` reattaches on first build.

## Reconnect procedure (one-time, dashboard required)

The Cloudflare GitHub App OAuth flow can only run from the dashboard, so this
procedure cannot be fully automated. ~2 min of clicking.

1. https://dash.cloudflare.com → Workers & Pages → `vtt-ui` → Settings → Delete
   project. (Confirms the project name; `*.pages.dev` will 404 until step 5.)
2. Workers & Pages → Create application → Pages → **Connect to Git**.
3. **+ Add account** → GitHub → Install & Authorize the **Cloudflare Workers and
   Pages** app on the `Worthingtravis/vtt-ui` repository. Pick *only this repo*.
4. Pick `Worthingtravis/vtt-ui` from the list. Project name **must be `vtt-ui`**
   (the R2 binding in `site/wrangler.toml` and the smoke test both hard-code
   `vtt-ui.pages.dev`). Production branch: `main`. **Root directory: `site`**.
   Build command: leave blank. Build output directory: leave blank
   (`pages_build_output_dir = "."` in `site/wrangler.toml` controls it).
5. Save and Deploy. The first build also re-binds R2 (`PUBLIC_BUCKET ↔
   vtt-public-prod`) automatically from `wrangler.toml`.
6. Re-add the production env vars: `LW_COOKIE_SECRET`, `LW_OAUTH_BASE_URL`,
   `LW_OAUTH_CLIENT_ID` (Settings → Variables and Secrets → Production). Values
   must match what was on the deleted project — pull from the OAuth provider's
   admin page if they were not saved elsewhere.

## Verify

```bash
git -C /mnt/ssd/development/vtt-ui commit --allow-empty -m "verify: pages git auto-deploy"
git -C /mnt/ssd/development/vtt-ui push origin main
# poll until a github:push deployment appears (usually <90s):
source /mnt/ssd/development/video-to-text/.env.local
curl -s -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/pages/projects/vtt-ui/deployments?per_page=5&page=1" \
  | jq '.result[0] | {short_id, trigger:.deployment_trigger.type, status:.latest_stage.status, commit:.deployment_trigger.metadata.commit_hash[:8]}'
# expected: {"trigger":"github:push","status":"success", ...}
/mnt/ssd/development/vtt-ui/bin/test-smoke
```

## How to re-diagnose if auto-deploy stops again

```bash
source /mnt/ssd/development/video-to-text/.env.local
# 1. Inspect the project's source block (must exist + type:"github" + deployments_enabled:true)
curl -s -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/pages/projects/vtt-ui" \
  | jq '.result | {name, production_branch, source}'

# 2. Check recent triggers — github:push vs ad_hoc
curl -s -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/pages/projects/vtt-ui/deployments?per_page=10&page=1" \
  | jq '.result[] | {short_id, trigger:.deployment_trigger.type, branch:.deployment_trigger.metadata.branch}'

# 3. Confirm GitHub App is still installed + has access to the repo
gh api repos/Worthingtravis/vtt-ui/hooks  # cloudflare webhook should be listed
# Or visit https://github.com/settings/installations → Cloudflare Workers and Pages → repo access

# 4. If the App is gone or repo access was revoked: dashboard → vtt-ui → Settings →
#    Builds → Manage (under Git Repository) → Reinstall.
```

The `source` block being absent (or `deployments_enabled:false`) is the canonical
"auto-deploy is broken" signal. If `source.type === "github"` but pushes still
don't trigger builds, check the GitHub repo's webhook deliveries
(`gh api repos/Worthingtravis/vtt-ui/hooks/<id>/deliveries`) for failures on the
Cloudflare receiver side.
