/**
 * Shared x402 types — the on-the-wire shapes from the protocol spec, plus
 * our gate's local types. Imported by `_x402.ts` and any handler that
 * adopts `x402Gate()`.
 *
 * Spec references:
 *   - https://www.x402.org/writing/x402-v2-launch
 *   - https://github.com/coinbase/x402
 */

import type { AuthEnv } from "./auth/_lib";

// ── Pages-Functions env shape that gated handlers see ─────────────────────

export interface GateEnv extends AuthEnv {
  // KV namespaces (created via `wrangler kv namespace create`):
  VTT_QUOTAS?: KVNamespace;       // optional during Phase 0 (shadow)
  VTT_API_KEYS?: KVNamespace;     // optional during Phase 0
  // Receiver wallet (public address; not a secret).
  X402_RECEIVER_ADDRESS?: string;
  // "base" or "base-sepolia". Default "base-sepolia" during shadow + Phase 1/2.
  X402_NETWORK?: "base" | "base-sepolia";
  // Facilitator URL. Default "https://x402.org/facilitator".
  X402_FACILITATOR_URL?: string;
  // "true" = log would-block events but pass everything through. Phase 0.
  // Anything else = enforce.
  SHADOW_MODE?: string;
}

// ── Per-handler config ─────────────────────────────────────────────────────

export interface GateConfig {
  // Endpoint slug used in KV keys + 402 description. Keep stable; renaming
  // moves users back to zero quota for the day.
  slug: string;
  // Display price, e.g. 0.10 for $0.10 USDC.
  priceUsd: number;
  // Human description shown in the 402 body + payment modal.
  description: string;
  // Free-tier window: { count, windowSec } or null for "always pay".
  freeQuota: { count: number; windowSec: number } | null;
}

// ── Gate result the handler proceeds with ──────────────────────────────────

export interface SessionPayload {
  sub: string;
  login: string | null;
  name?: string | null;
  picture?: string | null;
  exp: number;
}

export interface GateResult {
  session: SessionPayload | null;
  apiKey: string | null;
  // True iff a payment was received + verified for this request. False for
  // free-tier hits (and during shadow mode, whether or not it would have
  // blocked) — `shadowWouldBlock` distinguishes those.
  paymentVerified: boolean;
  receiptTxHash: string | null;
  // Phase-0 instrumentation: in shadow mode, set when the request would have
  // been blocked. Handler typically ignores; only the gate logs/writes it.
  shadowWouldBlock: boolean;
  // Identifier used for quota tracking (sub, then apiKey, else null = anon).
  identityKey: string | null;
}

// ── Protocol shapes (subset we need) ───────────────────────────────────────

export interface PaymentRequirement {
  scheme: "exact";
  network: "base" | "base-sepolia";
  maxAmountRequired: string;        // atomic units (USDC = 6 decimals)
  resource: string;                 // full URL
  description: string;
  mimeType: string;                 // for content-type negotiation
  payTo: string;                    // 0x receiver
  maxTimeoutSeconds: number;
  asset: string;                    // USDC contract
  // Future-proof — extra fields the spec adds without breaking us.
  [k: string]: unknown;
}

export interface PaymentVerifyResult {
  ok: boolean;
  requirement?: PaymentRequirement;
  payerAddress?: string;
  error?: string;
  raw?: unknown;
}

export interface PaymentSettleResult {
  ok: boolean;
  txHash?: string;
  error?: string;
  raw?: unknown;
}

// ── USDC contract addresses (from x402 spec) ───────────────────────────────

export const USDC_CONTRACT: Record<"base" | "base-sepolia", string> = {
  "base": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  "base-sepolia": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
};

export const DEFAULT_FACILITATOR = "https://x402.org/facilitator";
