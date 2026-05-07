/**
 * x402 micropayment gate — shared composer used by every handler that
 * meters compute (`/api/scan/queue`, `/api/scan/download_and_queue`, …).
 *
 * Returns either a `Response` (blocked: 401 / 402 / 500 / 502) or a
 * `GateResult` (passed: handler proceeds). The handler's pattern mirrors
 * `unpackSigned()` from `_lib.ts`: one call, one if-instanceof check, then
 * the handler runs.
 *
 * Phase 0 (current): SHADOW_MODE=true means the gate logs would-block
 * events and writes them to KV (`shadow:would_block:{key}:{ep}:{day}`)
 * but ALWAYS returns a GateResult — never blocks. Lets us calibrate the
 * free-tier knob with real traffic before charging real money.
 *
 * See `site/docs/x402_integration_plan.md` for the full design.
 */

import {
  AuthEnv,
  SESSION_COOKIE,
  readCookie,
  unpackSigned,
} from "./auth/_lib";

import type {
  GateEnv,
  GateConfig,
  GateResult,
  SessionPayload,
  PaymentRequirement,
  PaymentVerifyResult,
  PaymentSettleResult,
} from "./_x402_types";

import { USDC_CONTRACT, DEFAULT_FACILITATOR } from "./_x402_types";

// ── Helpers ────────────────────────────────────────────────────────────────

function jsonResponse(body: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      ...extraHeaders,
    },
  });
}

function utcDay(): string {
  // YYYY-MM-DD in UTC — matches the plan's window_start_utc_day key segment.
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

function isShadowMode(env: GateEnv): boolean {
  return env.SHADOW_MODE === "true";
}

function networkFor(env: GateEnv): "base" | "base-sepolia" {
  return env.X402_NETWORK === "base" ? "base" : "base-sepolia";
}

// ── Identity resolution ────────────────────────────────────────────────────

async function resolveSession(request: Request, env: GateEnv): Promise<SessionPayload | null> {
  if (!env.LW_COOKIE_SECRET) return null;
  return unpackSigned<SessionPayload>(env.LW_COOKIE_SECRET, readCookie(request, SESSION_COOKIE));
}

function resolveApiKey(request: Request): string | null {
  // Bearer token from Authorization header. We don't validate against KV
  // here — that happens later in `getApiKeyTier()`. This is the raw token.
  const auth = request.headers.get("authorization") ?? "";
  if (!auth.startsWith("Bearer ")) return null;
  const token = auth.slice("Bearer ".length).trim();
  return token || null;
}

// ── Quota tracking (KV) ────────────────────────────────────────────────────
//
// Key format: `quota:{identity}:{slug}:{utcDay}`. Value is a stringified
// integer. `expirationTtl: 86400 * 2` so entries self-evict.
//
// The classic GET-then-PUT race lets a user grab ~1-2 extra free calls per
// concurrent burst. Acceptable for a $0.10 gate; would warrant Durable
// Objects only if it becomes measurable.

const QUOTA_TTL_SEC = 86400 * 2;

function quotaKey(identity: string, slug: string): string {
  return `quota:${identity}:${slug}:${utcDay()}`;
}

async function getQuotaCount(kv: KVNamespace | undefined, identity: string, slug: string): Promise<number> {
  if (!kv) return 0;
  const v = await kv.get(quotaKey(identity, slug));
  if (!v) return 0;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : 0;
}

async function incrementQuota(kv: KVNamespace | undefined, identity: string, slug: string): Promise<void> {
  if (!kv) return;
  const k = quotaKey(identity, slug);
  const v = await kv.get(k);
  const n = (v ? parseInt(v, 10) : 0) || 0;
  await kv.put(k, String(n + 1), { expirationTtl: QUOTA_TTL_SEC });
}

// Phase-0 instrumentation: separate key, separate counter, doesn't touch
// the production quota namespace so it's safe to read-back when calibrating.
async function recordShadowWouldBlock(kv: KVNamespace | undefined, identity: string, slug: string): Promise<void> {
  if (!kv) return;
  const k = `shadow:would_block:${identity || "_anon"}:${slug}:${utcDay()}`;
  const v = await kv.get(k);
  const n = (v ? parseInt(v, 10) : 0) || 0;
  await kv.put(k, String(n + 1), { expirationTtl: QUOTA_TTL_SEC });
}

// ── 402 response builder ───────────────────────────────────────────────────

function build402Response(request: Request, env: GateEnv, config: GateConfig): Response {
  const network = networkFor(env);
  const asset = USDC_CONTRACT[network];
  const payTo = env.X402_RECEIVER_ADDRESS || "";
  // 6-decimal USDC: $0.10 → "100000"
  const maxAmountRequired = String(Math.round(config.priceUsd * 1_000_000));
  const requirement: PaymentRequirement = {
    scheme: "exact",
    network,
    maxAmountRequired,
    resource: request.url,
    description: config.description,
    mimeType: "application/json",
    payTo,
    maxTimeoutSeconds: 30,
    asset,
  };
  const headerB64 = btoa(JSON.stringify(requirement));
  return jsonResponse({
    ok: false,
    error: "payment_required",
    price_usd: config.priceUsd,
    price_atomic: maxAmountRequired,
    asset,
    network,
    pay_to: payTo,
    description: config.description,
    resource: request.url,
  }, 402, {
    "PAYMENT-REQUIRED": headerB64,
  });
}

// ── Facilitator calls ──────────────────────────────────────────────────────
//
// `verify` checks the signature + amount + recipient without broadcasting.
// `settle` broadcasts on-chain. We do verify-then-settle synchronously to
// keep things correct. Phase 5 may move settle async if the latency hurts.

async function verifyPayment(
  paymentHeader: string,
  request: Request,
  env: GateEnv,
  config: GateConfig,
): Promise<PaymentVerifyResult> {
  const facilitator = env.X402_FACILITATOR_URL || DEFAULT_FACILITATOR;
  const network = networkFor(env);
  const asset = USDC_CONTRACT[network];
  const payTo = env.X402_RECEIVER_ADDRESS || "";
  const requirement: PaymentRequirement = {
    scheme: "exact",
    network,
    maxAmountRequired: String(Math.round(config.priceUsd * 1_000_000)),
    resource: request.url,
    description: config.description,
    mimeType: "application/json",
    payTo,
    maxTimeoutSeconds: 30,
    asset,
  };
  let payload: unknown;
  try {
    payload = JSON.parse(atob(paymentHeader));
  } catch {
    return { ok: false, error: "invalid X-PAYMENT header (not base64-json)" };
  }
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 5000);
  let body: unknown;
  try {
    const r = await fetch(`${facilitator}/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ paymentHeader, paymentRequirements: requirement }),
      signal: ctl.signal,
    });
    body = await r.json();
    if (!r.ok) {
      return { ok: false, error: `facilitator /verify ${r.status}`, raw: body };
    }
  } catch (e) {
    return { ok: false, error: `facilitator unreachable: ${(e as Error).message}` };
  } finally {
    clearTimeout(timer);
  }
  // Spec field naming has wobbled across versions; accept either.
  const isValid = (body as { isValid?: boolean }).isValid === true || (body as { ok?: boolean }).ok === true;
  if (!isValid) {
    return { ok: false, error: "verify rejected", raw: body };
  }
  return {
    ok: true,
    requirement,
    payerAddress: (payload as { payload?: { authorization?: { from?: string } } }).payload?.authorization?.from,
    raw: body,
  };
}

async function settlePayment(
  paymentHeader: string,
  requirement: PaymentRequirement,
  env: GateEnv,
): Promise<PaymentSettleResult> {
  const facilitator = env.X402_FACILITATOR_URL || DEFAULT_FACILITATOR;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 15_000);
  try {
    const r = await fetch(`${facilitator}/settle`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ paymentHeader, paymentRequirements: requirement }),
      signal: ctl.signal,
    });
    const body = await r.json();
    if (!r.ok) return { ok: false, error: `facilitator /settle ${r.status}`, raw: body };
    const txHash =
      (body as { transaction?: string }).transaction ??
      (body as { txHash?: string }).txHash ??
      undefined;
    return { ok: true, txHash, raw: body };
  } catch (e) {
    return { ok: false, error: `settle failed: ${(e as Error).message}` };
  } finally {
    clearTimeout(timer);
  }
}

// ── Main entry point ───────────────────────────────────────────────────────

/**
 * Run the gate. Returns either:
 *   - GateResult — caller proceeds. Either free-tier, or paid + verified.
 *   - Response   — caller returns it directly (401/402/500/502).
 *
 * In SHADOW_MODE the gate ALWAYS returns a GateResult, even when it would
 * have blocked. `result.shadowWouldBlock` lets the handler tag forwarded
 * requests for downstream observability if needed.
 */
export async function x402Gate(
  request: Request,
  env: GateEnv,
  config: GateConfig,
): Promise<GateResult | Response> {
  const session = await resolveSession(request, env);
  const apiKey = resolveApiKey(request);
  const identityKey = session?.sub ?? apiKey ?? null;

  // 1. Free-tier check
  let withinFree = false;
  if (identityKey && config.freeQuota) {
    const used = await getQuotaCount(env.VTT_QUOTAS, identityKey, config.slug);
    withinFree = used < config.freeQuota.count;
  }
  if (withinFree) {
    if (identityKey) await incrementQuota(env.VTT_QUOTAS, identityKey, config.slug);
    return {
      session,
      apiKey,
      paymentVerified: false,
      receiptTxHash: null,
      shadowWouldBlock: false,
      identityKey,
    };
  }

  // 2. Quota exhausted (or anon with no free tier) — payment required
  const paymentHeader = request.headers.get("X-PAYMENT");

  if (!paymentHeader) {
    if (isShadowMode(env)) {
      // SHADOW MODE: log and pass through. Note: identityKey may be null
      // for fully anon — record under "_anon" so we can still see volume.
      await recordShadowWouldBlock(env.VTT_QUOTAS, identityKey || "", config.slug);
      console.log(`[x402:shadow] would_block slug=${config.slug} identity=${identityKey || "_anon"}`);
      // Still increment regular quota so calibration reflects "used 4/3 etc".
      if (identityKey) await incrementQuota(env.VTT_QUOTAS, identityKey, config.slug);
      return {
        session, apiKey, identityKey,
        paymentVerified: false,
        receiptTxHash: null,
        shadowWouldBlock: true,
      };
    }
    return build402Response(request, env, config);
  }

  // 3. Verify payment
  const verify = await verifyPayment(paymentHeader, request, env, config);
  if (!verify.ok) {
    if (isShadowMode(env)) {
      console.log(`[x402:shadow] verify_fail slug=${config.slug} error=${verify.error}`);
      return { session, apiKey, identityKey,
        paymentVerified: false, receiptTxHash: null, shadowWouldBlock: true };
    }
    return jsonResponse({
      ok: false, error: "payment_verification_failed", detail: verify.error,
    }, 402);
  }

  // 4. Settle on-chain
  const settle = await settlePayment(paymentHeader, verify.requirement!, env);
  if (!settle.ok) {
    if (isShadowMode(env)) {
      console.log(`[x402:shadow] settle_fail slug=${config.slug} error=${settle.error}`);
      return { session, apiKey, identityKey,
        paymentVerified: true, receiptTxHash: null, shadowWouldBlock: true };
    }
    // Treat settle failure as a 402 — the user can retry; no compute burned.
    return jsonResponse({
      ok: false, error: "payment_settle_failed", detail: settle.error,
    }, 402);
  }

  // 5. Record usage
  if (identityKey) await incrementQuota(env.VTT_QUOTAS, identityKey, config.slug);

  return {
    session, apiKey, identityKey,
    paymentVerified: true,
    receiptTxHash: settle.txHash ?? null,
    shadowWouldBlock: false,
  };
}

// ── Handler-side convenience ───────────────────────────────────────────────

/**
 * Optional helper: forward x402 metadata as request headers when the
 * handler calls serve.py. serve.py doesn't validate (edge already did);
 * these are audit-trail only.
 */
export function x402AuditHeaders(gate: GateResult): Record<string, string> {
  return {
    "x-vtt-payment-verified": gate.paymentVerified ? "1" : "0",
    "x-vtt-receipt-tx": gate.receiptTxHash ?? "",
    "x-vtt-payment-shadow-block": gate.shadowWouldBlock ? "1" : "0",
  };
}
