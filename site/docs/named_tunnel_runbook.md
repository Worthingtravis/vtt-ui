# Named Tunnel Migration Runbook

Replace the rotating quick-tunnel with a named cloudflared tunnel + systemd
unit so the `vtt-ui.pages.dev → serve.py` hop survives serve.py restarts.

## Phase 0 — Discovery (run before touching anything)

```bash
ps aux | grep cloudflared
cloudflared --version
curl -s https://pub-868d2bf7e2f6434c860d65dfe1cadad4.r2.dev/config.json | python3 -m json.tool
ls -la ~/.cloudflared/ 2>/dev/null || echo "no user .cloudflared dir"
ls -la /etc/cloudflared/ 2>/dev/null || echo "no /etc/cloudflared dir"
systemctl status cloudflared 2>/dev/null || echo "no cloudflared.service"
systemctl status cloudflared-vtt 2>/dev/null || echo "no cloudflared-vtt.service"

# Confirm laughingwhales.com lives in the same Cloudflare account:
source /mnt/ssd/development/video-to-text/.env.local
curl -s -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  "https://api.cloudflare.com/client/v4/zones?name=laughingwhales.com" \
  | python3 -m json.tool | grep '"id"\|"name"\|"status"'
```

## Path A — Named tunnel on `laughingwhales.com` (preferred)

Stable hostname will be `serve.laughingwhales.com` (or `api.laughingwhales.com`).

### Step 1 — Authenticate

```bash
cloudflared tunnel login   # browser flow; writes ~/.cloudflared/cert.pem
```

### Step 2 — Create the tunnel

```bash
cloudflared tunnel create vtt-serve
# Note the UUID and the credentials JSON path it prints.
cloudflared tunnel list
```

### Step 3 — Config file at /etc/cloudflared

```bash
sudo mkdir -p /etc/cloudflared
sudo cp ~/.cloudflared/<UUID>.json /etc/cloudflared/<UUID>.json
sudo chmod 600 /etc/cloudflared/<UUID>.json

sudo tee /etc/cloudflared/config.yml > /dev/null << 'EOF'
tunnel: <UUID>
credentials-file: /etc/cloudflared/<UUID>.json

ingress:
  - hostname: serve.laughingwhales.com
    service: http://localhost:8765
  - service: http_status:404
EOF
```

### Step 4 — DNS CNAME

```bash
cloudflared tunnel route dns vtt-serve serve.laughingwhales.com
```

### Step 5 — systemd unit

```bash
sudo tee /etc/systemd/system/cloudflared-vtt.service > /dev/null << 'EOF'
[Unit]
Description=Cloudflare Tunnel — vtt serve.py ingress
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=root
ExecStart=/usr/local/bin/cloudflared tunnel \
  --config /etc/cloudflared/config.yml \
  --no-autoupdate \
  run vtt-serve
Restart=on-failure
RestartSec=5s
TimeoutStartSec=30
StandardOutput=journal
StandardError=journal
SyslogIdentifier=cloudflared-vtt

[Install]
WantedBy=multi-user.target
EOF
```

### Step 6 — Enable + start

```bash
sudo systemctl daemon-reload
sudo systemctl enable cloudflared-vtt.service
sudo systemctl start cloudflared-vtt.service
sudo systemctl status cloudflared-vtt.service
journalctl -u cloudflared-vtt -n 50 --no-pager
```

### Step 7 — Smoke test

```bash
curl -s https://serve.laughingwhales.com/api/jobs | python3 -m json.tool
# Expect 200 + jobs array
```

## Path B — `*.cfargotunnel.com` (no custom domain)

If `laughingwhales.com` is in a different Cloudflare account:

- Skip Step 4 (DNS).
- Drop the `hostname:` line from `config.yml` so the tunnel answers on `<UUID>.cfargotunnel.com`.
- Pages Function uses that UUID hostname as `render_api_base`.

## Phase 3 — Flip render_api_base in R2 config.json

```bash
(
  set -a && . /mnt/ssd/development/video-to-text/.env.local && set +a
  aws s3 cp \
    s3://vtt-public-prod/config.json \
    /tmp/vtt-config-backup-$(date +%Y%m%d%H%M%S).json \
    --endpoint-url https://715860740aa429771837f856d175bd83.r2.cloudflarestorage.com
  aws s3 cp \
    s3://vtt-public-prod/config.json - \
    --endpoint-url https://715860740aa429771837f856d175bd83.r2.cloudflarestorage.com \
  | python3 -c "
import sys, json
d = json.load(sys.stdin)
d['render_api_base'] = 'https://serve.laughingwhales.com'
print(json.dumps(d, indent=2))
" \
  | aws s3 cp - \
    s3://vtt-public-prod/config.json \
    --endpoint-url https://715860740aa429771837f856d175bd83.r2.cloudflarestorage.com \
    --content-type application/json
  curl -s https://pub-868d2bf7e2f6434c860d65dfe1cadad4.r2.dev/config.json | python3 -m json.tool
)
```

For Path B, replace `serve.laughingwhales.com` with `<UUID>.cfargotunnel.com`.

## Phase 4 — Verify (after next idle serve.py restart)

```bash
sudo systemctl status cloudflared-vtt
curl -s https://serve.laughingwhales.com/api/jobs
curl -s https://vtt-ui.pages.dev/api/creators | python3 -c "import sys,json; d=json.load(sys.stdin); print('OK,', len(d.get('creators',[])), 'creators')"
cd /mnt/ssd/development/vtt-ui && bin/test-smoke
```

## Rollback

```bash
sudo systemctl stop cloudflared-vtt
sudo systemctl disable cloudflared-vtt

# Re-launch the old quick-tunnel with whatever args were in `ps aux`
# Restore old config.json from the timestamped backup in /tmp/

(
  set -a && . /mnt/ssd/development/video-to-text/.env.local && set +a
  aws s3 cp /tmp/vtt-config-backup-<TIMESTAMP>.json \
    s3://vtt-public-prod/config.json \
    --endpoint-url https://715860740aa429771837f856d175bd83.r2.cloudflarestorage.com \
    --content-type application/json
)
```

## Notes

- `--no-autoupdate` keeps cloudflared from silently restarting itself mid-flight.
- Config at `/etc/cloudflared/` (not `~/.cloudflared/`) is the canonical pattern for root-run systemd services. `cloudflared service install` looks in `/root/.cloudflared/` under sudo, which is wrong.
- Credentials JSON + cert.pem both `chmod 600`. Cert is only for admin ops; daemon only needs the JSON.

## Sources

- https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/local-management/as-a-service/linux/
- https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/local-management/create-local-tunnel/
- https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/local-management/configuration-file/
- https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/routing-to-tunnel/dns/
