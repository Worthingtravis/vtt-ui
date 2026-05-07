# x402 Micropayment Gate — Integration Plan

**Scope:** Wire x402 USDC/Base micropayments to gate compute-heavy public API endpoints on vtt-ui.pages.dev, starting with `/api/scan/queue` and `/api/scan/download_and_queue` (the real cost centres), and extending the same middleware to all three product avenues.

For payment-rail fundamentals see memory `project_x402_payment_rail.md`.

## 1. Current State Audit

### Existing auth pattern (every gated route)

`/api/scan/queue.ts:68-77`, `/api/scan/download_and_queue.ts:56-66`, `/api/event_label/append.ts:65-76` all do:

```
unpackSigned(env.LW_COOKIE_SECRET, readCookie(request, SESSION_COOKIE))
  → 401 if null/expired
  → forward to serve.py with X-VTT-User-Sub / X-VTT-User-Login headers
```

**No global `_middleware.ts`.** Every function is standalone. `AuthEnv` from `functions/api/auth/_lib.ts` is the only shared abstraction.

### No existing x402 code

Grepping the repo for `x402`, `hono`, `USDC`, `micropayment`, `payment` returns only roadmap text in `site/index.html`. No drop-in template exists; everything is net-new.

### Gating priority

| Route | Cost class | Gate? |
|---|---|---|
| `POST /api/scan/queue` | xcorr scan CPU + R2 read | yes |
| `POST /api/scan/download_and_queue` | VOD download (GB) + scan | yes |
| `POST /api/event_label/append` | label write | NO — labels are the network effect |
| `GET /api/search` | R2 read | NO — gating search kills the product |
| `GET /api/events` | R2 read | NO |

## 2. Protocol Summary (x402 v2, May 2025)

1. Client `POST` to gated route.
2. No `X-PAYMENT` header + quota exhausted → `402` with `PAYMENT-REQUIRED` header (b64 PaymentRequirement) + JSON body for the modal.
3. Client signs EIP-712 transfer authorisation, retries with `X-PAYMENT: <b64 PaymentPayload>`.
4. Edge calls facilitator `POST /verify`; on success optionally `POST /settle`.
5. On verified pay: forward to serve.py, return 200 + `PAYMENT-RESPONSE` header with tx hash.

```typescript
interface PaymentRequirement {
  scheme: "exact";
  network: "base" | "base-sepolia";
  maxAmountRequired: string;   // atomic USDC units (6 decimals)
  resource: string;
  description: string;
  mimeType: string;
  payTo: string;
  maxTimeoutSeconds: number;
  asset: string;
}

interface PaymentPayload {
  x402Version: number;
  scheme: "exact";
  network: string;
  payload: { signature: string; authorization: TransferAuthorization };
}
```

Public CDP facilitator: `https://x402.org/facilitator`. Free ≤1k tx/month. Above that, fees come out of the settled USDC.

## 3. Pricing Model

**Flat per-call. No duration tiering.** VOD duration is unknown at submission time; fetching it adds round-trips for marginal precision. Dominant cost is xcorr CPU which only varies 2-3× across typical lengths.

| Endpoint | Price |
|---|---|
| `POST /api/scan/queue` | $0.10 |
| `POST /api/scan/download_and_queue` | $0.25 |
| `POST /api/search` | free |
| `GET /api/events` | free |
| `POST /api/event_label/append` | free |

USDC contracts: Base mainnet `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`, Sepolia `0x036CbD53842c5426634e7929541eC2318f3dCF7e`.

## 4. Free Tier Rules

| Class | scan/queue | download+queue | Resets |
|---|---|---|---|
| Anonymous | 0 | 0 | — |
| OAuth-free-tier | 3/day | 1/day | UTC midnight |
| OAuth-paid-tier (has API key in KV) | 50/day | 10/day | UTC midnight |
| API key (machine) | 0 | 0 | always pay |

Paid-tier distinction = presence of a `VTT_API_KEYS` entry. Auto-issued on first successful payment. No manual upgrade flow.

Discord-linked tier deferred to Open Questions.

## 5. Middleware Architecture

Pages Functions has no global middleware. Use a **shared composer function** that each gated handler calls at the top — same pattern as `unpackSigned`.

```typescript
export interface GateEnv extends AuthEnv {
  VTT_QUOTAS: KVNamespace;
  VTT_PAYMENTS: D1Database;       // Phase 3+
  X402_RECEIVER_ADDRESS: string;
  X402_NETWORK: "base" | "base-sepolia";
  X402_FACILITATOR_URL?: string;
}

export interface GateConfig {
  priceUsd: number;
  description: string;
  freeQuota: { count: number; windowSec: number } | null;
}

export interface GateResult {
  session: SessionPayload | null;
  apiKey: string | null;
  paymentVerified: boolean;
  receiptTxHash: string | null;
}

export async function x402Gate(
  request: Request, env: GateEnv, config: GateConfig,
): Promise<GateResult | Response>;
```

Return-type union: caller gets back a `Response` → return immediately. Gets back `GateResult` → proceed.

**Internal flow:**

```typescript
async function x402Gate(request, env, config) {
  const session = await resolveSession(request, env);
  const apiKey = resolveApiKey(request);
  const identityKey = session?.sub ?? apiKey ?? null;

  if (identityKey && config.freeQuota) {
    const used = await getQuotaCount(env.VTT_QUOTAS, identityKey, config.freeQuota.windowSec);
    if (used < config.freeQuota.count) {
      return { session, apiKey, paymentVerified: false, receiptTxHash: null };
    }
  }

  const paymentHeader = request.headers.get("X-PAYMENT");
  if (!paymentHeader) return build402Response(request, env, config);

  const verify = await verifyPayment(paymentHeader, request, env, config);
  if (!verify.ok) return new Response(JSON.stringify({ ok: false,
    error: "payment_verification_failed", detail: verify.error }), { status: 402 });

  const receipt = await settlePayment(paymentHeader, verify.requirement, env);
  if (identityKey) {
    await incrementQuota(env.VTT_QUOTAS, identityKey, config.freeQuota?.windowSec ?? 86400);
  }
  return { session, apiKey, paymentVerified: true, receiptTxHash: receipt?.txHash ?? null };
}
```

**Each handler adoption:**

```typescript
const gate = await x402Gate(request, env, {
  priceUsd: 0.10,
  description: "Queue a VOD event scan",
  freeQuota: { count: 3, windowSec: 86400 },
});
if (gate instanceof Response) return gate;
// gate.session / gate.apiKey now available; forward to serve.py
```

Forwarded headers gain:
```
x-vtt-payment-verified: gate.paymentVerified ? "1" : "0"
x-vtt-receipt-tx:       gate.receiptTxHash ?? ""
```

serve.py doesn't validate (edge already did) — audit trail only.

## 6. KV Schema

**`VTT_QUOTAS`** key: `quota:{sub_or_apikey}:{endpoint_slug}:{utc_day}` — value: integer string. `expirationTtl: 86400 * 2`.

**`VTT_API_KEYS`** key: `apikey:{sha256_prefix_16hex}` — value: `{sub, created_at, tier: "paid"}`. Never store raw key.

**`VTT_PAYMENTS` (D1, Phase 3+):**
```sql
CREATE TABLE receipts (
  id TEXT PRIMARY KEY, user_sub TEXT, api_key_id TEXT,
  endpoint TEXT NOT NULL, tx_hash TEXT,
  amount_usd REAL NOT NULL, network TEXT NOT NULL, asset TEXT NOT NULL,
  created_at TEXT NOT NULL, settled_at TEXT
);
CREATE INDEX receipts_user_sub ON receipts(user_sub);
```

D1 is for receipt history + future billing dashboard, not quota enforcement (KV covers that). Defer.

## 7. UI Flow

### Anonymous + 402

Modal:
> **Queue a VOD scan — $0.10 USDC on Base**
> This submission uses GPU time. Pay once or sign in for 3 free scans/day.
> [Connect Wallet] [Sign In with Twitch]

Connect Wallet → `window.ethereum` → `eth_signTypedData_v4` → retry POST with `X-PAYMENT` → 200.

### OAuth quota exhausted

Same modal, copy:
> You've used your 3 free scans today. Pay $0.10 USDC on Base or wait until midnight UTC.

### AI agent

`@x402/fetch` auto-retries on 402. No UI. Pre-funded CDP wallet on Base.

### Modal implementation

Lazy-loaded `paymentModal.js` (dynamic import on first 402). No cold-load weight for browsing users.

## 8. Refunds and Retries

**Do NOT use x402r at launch.** Escrow + on-chain refund adds latency and complexity not justified by $0.10 payments.

**Credit-based retry policy (off-chain):**

On `download_and_queue` failure (410 vod_audio_unrecoverable, 502 serve.py down): write `credit:{sub_or_apikey}` → integer count. Next submission consumes credit before quota/payment check. Document: "VOD scan failures get one free retry credit. Credits expire 30 days."

## 9. Tier Matrix

| | Anonymous | OAuth-free | OAuth-paid | API key |
|---|---|---|---|---|
| Identity | none | session cookie | session cookie | Bearer |
| scan/queue free/day | 0 | 3 | 3 | 0 |
| download/queue free/day | 0 | 1 | 1 | 0 |
| Pays after quota | always | yes | yes | always |
| API key issuance | no | on first pay | yes | pre-issued |
| Retry credit on failure | no | yes | yes | yes |

## 10. Rollout Runbook

### Phase 0 — Shadow on Base Sepolia

- Deploy `_x402.ts` with `SHADOW_MODE=true` flag — gate logs but doesn't enforce.
- Instrument: KV key `shadow:would_block:{sub}:{endpoint}:{day}` per would-block.
- Run 1 week. Measure free-tier usage to calibrate.
- Test 1 real Sepolia payment for connectivity.

Files: new `site/functions/api/_x402.ts`, modified `site/wrangler.toml` (KV bindings + env vars).

### Phase 1 — Enable on `/api/scan/queue` (Sepolia, fake $)

- Remove SHADOW_MODE for queue.ts.
- Test full browser flow with Coinbase Wallet on Sepolia.

### Phase 2 — Enable on `/api/scan/download_and_queue` (Sepolia)

- Same as Phase 1 for download_and_queue.ts.
- Test retry-credit flow with a known-bad VOD.

### Phase 3 — Switch to Base mainnet

- Cloudflare dashboard → Production env: `X402_NETWORK=base`, mainnet USDC contract.
- No code change.
- Verify: real $0.10 payment lands in receiver wallet, D1 receipt row written.
- Add D1 binding + apply migration.

### Phase 4 — Extend to MCP-as-a-service

MCP tools land at serve.py, not Pages Functions. Implement Python `x402_middleware.py` reading the same KV namespace via Cloudflare REST API (token already in `.env.local`).

### Phase 5 — API key issuance UI + receipt history

- Auto-issue API key on first payment, return in response body, display once with copy-to-clipboard.
- `GET /api/receipts` (auth-gated) returns D1 history.

## 11. Files

### New

| Path | Purpose |
|---|---|
| `site/functions/api/_x402.ts` | `x402Gate()`, KV helpers, facilitator calls, `build402Response()` |
| `site/functions/api/_x402_types.ts` | shared interfaces |
| `site/x402_payment_modal.js` | browser-side EIP-712 sign + retry |

### Modified

| Path | Change |
|---|---|
| `site/wrangler.toml` | KV `VTT_QUOTAS` + `VTT_API_KEYS`; D1 `VTT_PAYMENTS` (P3); env vars |
| `site/functions/api/scan/queue.ts` | replace inline auth with `x402Gate` |
| `site/functions/api/scan/download_and_queue.ts` | same, $0.25 |
| `site/functions/api/auth/_lib.ts` | export `SessionPayload` interface |
| `site/index.html` | lazy-import modal on 402 |
| `site/DEPLOY.md` | document KV + D1 + env vars |

## 12. Risks

**Facilitator downtime.** Public CDP facilitator is third-party. On `/verify` timeout (>3s), return `503 payment_gateway_unavailable`. NEVER fall through to approving — that's worse than blocking. Admin allowlist (env var) for emergency bypass.

**Wallet UX friction.** Most users lack a Base wallet with USDC. Modal links to `pay.coinbase.com` onramp. Free OAuth tier is the main mitigation.

**Chargebacks.** None for ERC-20. `maxTimeoutSeconds=30` limits replay window.

**KV race on quota.** No atomic increment. TOCTOU window allows ~1-2 extra free calls per burst — minor budget leak, not a security issue. Durable Objects mitigate if it becomes measurable.

**API key leakage.** Long-lived. Mitigation: 1-year KV TTL, `DELETE /api/api_keys/mine` for rotation.

**x402 spec churn.** v1 → v2 changed header names. Pin facilitator integration version, log `x402Version` in receipts so v3 migration is detectable.

## 13. Open Questions

1. **Receiver wallet address.** What 0x on Base mainnet? Recommend Coinbase Smart Wallet. Not a CEX deposit address (memo issues).
2. **Free-tier count.** 3 scan/day correct, or 1 (drive conversion) or 5 (reduce friction)?
3. **API key UX.** Browser one-time display vs email to Twitch-linked address?
4. **Discord tier** (3 → 10 free/day for Discord members)? Defer or build now?
5. **Facilitator choice.** Public CDP (1k free tx/month) vs self-host? Public until volume exceeds 800/month, then reassess.
6. **MCP gate scope.** Phase 4 — which MCP tools first? `submit_vod` + `transcribe_creator` are obvious; `search` + `list_clips` stay free.
7. **x402r escrow refunds** vs the credit-based off-chain plan? Acceptable for $0.10 micropayments?
8. **Settlement timing.** Sync settle (await tx hash, +2s latency) vs async fire-and-forget (return 200 with "settlement pending")?

## Sources

- https://developers.cloudflare.com/agents/agentic-payments/x402/
- https://docs.cdp.coinbase.com/x402/welcome
- https://github.com/coinbase/x402
- https://www.x402.org/writing/x402-v2-launch
- https://blog.cloudflare.com/x402/
- https://developers.cloudflare.com/pages/functions/bindings/
- https://www.x402r.org/

## Key findings that shaped the design

**No existing x402 code in the repo.** The memory note about a "drop-in template already built" was aspirational. Everything in `_x402.ts` is net-new.

**No global `_middleware.ts` in this codebase.** Every Pages Function is standalone. The chosen pattern (shared composer imported per-handler) matches the existing `unpackSigned` style exactly.

**Two routes that matter:** `scan/queue` and `scan/download_and_queue`. These are the GPU/bandwidth burners. Search/events/labels stay free.

**Biggest blocker is the receiver wallet address.** Without it, `PaymentRequirement` cannot be constructed. Everything else is deterministic once that's resolved.
