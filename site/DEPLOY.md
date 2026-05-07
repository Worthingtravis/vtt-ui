# Deploy

## How vtt-ui ships

Every push to `main` triggers a GitHub Actions workflow
(`.github/workflows/pages-deploy.yml`) that runs
`wrangler pages deploy site/ --project-name=vtt-ui --branch=main`. The Cloudflare
Pages dashboard reflects the deploy as a `deployment_trigger.type: "ad_hoc"` —
that's expected (Direct Upload + CI). The user-facing result is identical to a
native Git integration: `git push` → site updates ~60s later, no manual command.

Manual deploys remain available as the fallback:

```bash
source /mnt/ssd/development/video-to-text/.env.local
cd /home/laughingwhales/development/vtt-ui/site
npx -y wrangler@latest pages deploy . --project-name=vtt-ui --branch=main \
  --commit-dirty=true
```

Use the manual path when iterating without committing, or when the GitHub Action
itself is broken (rare).

## Why GitHub Actions and not native Git integration

The `vtt-ui` Pages project was created via `wrangler pages deploy` (Direct
Upload). Cloudflare does not allow converting a Direct Upload project to native
Git integration after the fact — confirmed across multiple official docs (see
`/pages/get-started/direct-upload/`, `/pages/configuration/git-integration/`,
`/pages/platform/known-issues/`). The only path to native Git integration would
be deleting the project and recreating it from the dashboard with Git, which is
disruptive (~2 min downtime + GitHub App reauth + manual re-add of three runtime
secrets).

GitHub Actions + `cloudflare/wrangler-action@v3` is Cloudflare's officially-
documented escape hatch for this exact case
(`/pages/how-to/use-direct-upload-with-continuous-integration/`). Outcome is
identical for our workflow; we lose only per-PR preview deployments, which we
don't currently use.

## Required secrets

GitHub Actions needs two secrets on the `Worthingtravis/vtt-ui` repository:

| Name                    | Source                                       |
| ----------------------- | -------------------------------------------- |
| `CLOUDFLARE_API_TOKEN`  | `.env.local` on the serve.py box             |
| `CLOUDFLARE_ACCOUNT_ID` | `.env.local` on the serve.py box             |

To rotate or re-add:

```bash
source /mnt/ssd/development/video-to-text/.env.local
gh secret set CLOUDFLARE_API_TOKEN  --body "$CLOUDFLARE_API_TOKEN"  --repo Worthingtravis/vtt-ui
gh secret set CLOUDFLARE_ACCOUNT_ID --body "$CLOUDFLARE_ACCOUNT_ID" --repo Worthingtravis/vtt-ui
```

Pages Functions runtime secrets (`LW_COOKIE_SECRET`, `LW_OAUTH_BASE_URL`,
`LW_OAUTH_CLIENT_ID`) live on the Cloudflare Pages project itself (Settings →
Variables and Secrets → Production) and **don't** need to round-trip through
GitHub — `wrangler pages deploy` only uploads code; runtime secrets stay in
Cloudflare's vault.

## Verify

```bash
git -C /mnt/ssd/development/vtt-ui commit --allow-empty -m "verify: pages auto-deploy"
git -C /mnt/ssd/development/vtt-ui push origin main
# Watch the Action run:
gh run watch --repo Worthingtravis/vtt-ui
# When it completes, smoke test:
/mnt/ssd/development/vtt-ui/bin/test-smoke
```

## Re-diagnose if auto-deploy stops

```bash
# 1. Did the Action even run? List recent runs:
gh run list --repo Worthingtravis/vtt-ui --workflow pages-deploy.yml --limit 5

# 2. If the Action ran but failed, get logs:
gh run view --repo Worthingtravis/vtt-ui --log-failed

# 3. If the secrets got rotated, re-set them (see "Required secrets" above).

# 4. If wrangler-action's pinned version drifts and the deploy starts erroring
#    on a flag, pin a known-good version in pages-deploy.yml — the action's
#    @v3 tag floats on minor releases and has occasionally introduced regressions.

# 5. Sanity-check that the Cloudflare API token still has Pages:Edit + R2 perms:
source /mnt/ssd/development/video-to-text/.env.local
curl -s -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/tokens/verify" \
  | jq '.result.status'
```

## If we ever want native Git integration

The cost is one-time disruption + three secrets to re-add. Path:

1. Save the values of `LW_COOKIE_SECRET`, `LW_OAUTH_BASE_URL`, `LW_OAUTH_CLIENT_ID`
   from the current Pages project (Settings → Variables and Secrets).
2. Dashboard → Workers & Pages → `vtt-ui` → Settings → Delete project. (`*.pages.dev`
   will 404 until step 5.)
3. Workers & Pages → Create application → Pages → **Connect to Git** → **+ Add
   account** → install **Cloudflare Workers and Pages** GitHub App on
   `Worthingtravis/vtt-ui`.
4. Pick the repo. Project name **must be `vtt-ui`** (R2 binding + smoke test
   hard-code the URL). Root directory: `site`. Production branch: `main`. Build
   command + output dir: blank (`pages_build_output_dir = "."` in
   `site/wrangler.toml` controls it).
5. Save and Deploy. The R2 binding (`PUBLIC_BUCKET ↔ vtt-public-prod`) reattaches
   from `wrangler.toml` on first build.
6. Re-add the three secrets to Settings → Variables and Secrets → Production.
7. Delete `.github/workflows/pages-deploy.yml` (no longer needed).

This is documented as a fallback only. The Action-based path is the supported
default until/unless preview-per-PR becomes important.
