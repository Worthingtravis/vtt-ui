/**
 * GET /api/x402/test  — public x402 testbed
 *
 * Always 402s in production (no auth, no free tier). Sign + retry with
 * X-PAYMENT lands a 200 plus the on-chain receipt. Used to verify the
 * Sepolia → facilitator → settle path without burning real production
 * quota or polluting the scan queue.
 *
 * Mainnet safety: this endpoint AUTO-DISABLES (410 Gone) when
 * X402_NETWORK === "base" unless X402_TESTBED_ENABLED === "true". The
 * testbed accepts EIP-3009 transfers from any wallet — leaving it open
 * on mainnet would let any visitor hand $0.01-$1 USDC to the receiver
 * with zero auth gate. That's harmless tip-jar income, but turns
 * "an accidentally-shared link" into a real-money charge for whoever
 * follows it. Default-deny on mainnet is the conservative posture.
 *
 * Request:  GET /api/x402/test  (no body)
 * Response: 402  PaymentRequirement (no header)
 *           200  { ok: true, paid: true, txHash, payerAddress, network, asset, price_usd }
 *           402  { ok: false, error: "payment_verification_failed" | "payment_settle_failed", detail }
 *           410  { ok: false, error: "testbed_disabled_on_mainnet" } — unless X402_TESTBED_ENABLED=true
 *
 * Price: $0.01 USDC by default — small enough to repeat freely, large
 * enough to exercise the real settlement path. Override with
 * ?price_usd=0.05 or any value the wallet will sign for.
 */

import { x402Gate } from "../_x402";
import type { GateEnv } from "../_x402_types";

interface TestbedEnv extends GateEnv {
  X402_TESTBED_ENABLED?: string;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

function clampPrice(input: string | null): number {
  const n = input ? parseFloat(input) : NaN;
  if (!Number.isFinite(n) || n <= 0) return 0.01;
  // Refuse anything over $1 — this is a testbed, not a tip jar.
  return Math.min(n, 1.00);
}

// Both GET and POST so it's easy to hit from curl, fetch, or a paste-bar test.
export const onRequest: PagesFunction<TestbedEnv> = async ({ request, env }) => {
  // Mainnet hard-gate: refuse all traffic unless the operator has
  // explicitly opted-in to running the testbed against real USDC.
  if (env.X402_NETWORK === "base" && env.X402_TESTBED_ENABLED !== "true") {
    return json({
      ok: false,
      error: "testbed_disabled_on_mainnet",
      detail: "X402_NETWORK=base requires X402_TESTBED_ENABLED=true to enable this route. " +
              "The testbed accepts payments from any wallet without auth — disabled by default on mainnet.",
    }, 410);
  }
  const url = new URL(request.url);
  const priceUsd = clampPrice(url.searchParams.get("price_usd"));
  const gate = await x402Gate(request, env, {
    slug: "x402_test",
    priceUsd,
    description: `x402 testbed payment ($${priceUsd.toFixed(2)} USDC on ${env.X402_NETWORK || "base-sepolia"})`,
    freeQuota: null,            // ALWAYS pay — that's the whole point
  });
  if (gate instanceof Response) return gate;
  // gate.paymentVerified is true when a real payment cleared. In SHADOW_MODE
  // it's false but `shadowWouldBlock` is true; surface both so the user can
  // see what the production behaviour would have been.
  return json({
    ok: true,
    paid: gate.paymentVerified,
    txHash: gate.receiptTxHash,
    payerAddress: null,         // facilitator strips this from /settle response in some versions
    network: env.X402_NETWORK || "base-sepolia",
    asset: "USDC",
    price_usd: priceUsd,
    receiver: env.X402_RECEIVER_ADDRESS,
    shadow_mode: env.SHADOW_MODE === "true",
    would_have_blocked: gate.shadowWouldBlock,
    identity: gate.identityKey,
  });
};
