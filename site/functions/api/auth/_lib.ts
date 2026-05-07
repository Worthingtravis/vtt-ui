/**
 * Shared helpers for the vtt-ui ↔ laughingwhales.com OAuth bridge.
 *
 * Pages Functions run on Workers; we use Web Crypto everywhere — no Node
 * deps. Cookies carry signed payloads (HMAC-SHA256 with LW_COOKIE_SECRET)
 * because Pages projects don't have free KV/D1 by default and a cookie
 * for the 5-minute PKCE window keeps the deploy zero-dependency.
 */

export interface AuthEnv {
  // Provider config
  LW_OAUTH_CLIENT_ID: string;
  LW_OAUTH_BASE_URL?: string; // defaults to https://laughingwhales.com
  // HMAC secret for signing cookies (PKCE state + session token).
  // Generate via `openssl rand -hex 32`.
  LW_COOKIE_SECRET: string;
}

export const DEFAULT_LW_BASE = "https://laughingwhales.com";

const enc = new TextEncoder();
const dec = new TextDecoder();

// ── Base64url ───────────────────────────────────────────────────────────────

export function b64urlEncode(bytes: ArrayBuffer | Uint8Array): string {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64urlDecode(s: string): Uint8Array {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = s.length % 4;
  if (pad) s += "=".repeat(4 - pad);
  const bin = atob(s);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8;
}

// ── Random ──────────────────────────────────────────────────────────────────

export function randomBytes(n: number): Uint8Array {
  const u8 = new Uint8Array(n);
  crypto.getRandomValues(u8);
  return u8;
}

export function randomToken(byteLen = 32): string {
  return b64urlEncode(randomBytes(byteLen));
}

// ── PKCE ────────────────────────────────────────────────────────────────────

export async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", enc.encode(verifier));
  return b64urlEncode(digest);
}

// ── HMAC ────────────────────────────────────────────────────────────────────

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

async function sign(secret: string, data: string): Promise<string> {
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(data));
  return b64urlEncode(sig);
}

async function verify(secret: string, data: string, sig: string): Promise<boolean> {
  try {
    const key = await hmacKey(secret);
    return await crypto.subtle.verify(
      "HMAC",
      key,
      b64urlDecode(sig),
      enc.encode(data),
    );
  } catch {
    return false;
  }
}

// ── Signed payload (cookie-friendly) ────────────────────────────────────────

/**
 * Encodes `{ ...payload, exp }` as `<b64url(payload)>.<b64url(hmac)>`.
 * `exp` is a unix-second deadline. Verification rejects expired payloads.
 */
export async function packSigned(
  secret: string,
  payload: Record<string, unknown>,
  ttlSeconds: number,
): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const body = b64urlEncode(enc.encode(JSON.stringify({ ...payload, exp })));
  const sig = await sign(secret, body);
  return `${body}.${sig}`;
}

export async function unpackSigned<T extends Record<string, unknown>>(
  secret: string,
  token: string | null | undefined,
): Promise<(T & { exp: number }) | null> {
  if (!token) return null;
  const dot = token.indexOf(".");
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (!(await verify(secret, body, sig))) return null;
  let parsed: T & { exp: number };
  try {
    parsed = JSON.parse(dec.decode(b64urlDecode(body))) as T & { exp: number };
  } catch {
    return null;
  }
  if (typeof parsed.exp !== "number" || parsed.exp <= Math.floor(Date.now() / 1000)) {
    return null;
  }
  return parsed;
}

// ── Cookies ─────────────────────────────────────────────────────────────────

export function readCookie(request: Request, name: string): string | null {
  const raw = request.headers.get("cookie") ?? "";
  for (const part of raw.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}

export function setCookieHeader(opts: {
  name: string;
  value: string;
  maxAgeSeconds: number;
  path?: string;
  sameSite?: "Lax" | "Strict" | "None";
  secure?: boolean;
  httpOnly?: boolean;
}): string {
  const path = opts.path ?? "/";
  const sameSite = opts.sameSite ?? "Lax";
  const secure = opts.secure !== false;
  const httpOnly = opts.httpOnly !== false;
  const parts = [
    `${opts.name}=${encodeURIComponent(opts.value)}`,
    `Path=${path}`,
    `Max-Age=${opts.maxAgeSeconds}`,
    `SameSite=${sameSite}`,
  ];
  if (secure) parts.push("Secure");
  if (httpOnly) parts.push("HttpOnly");
  return parts.join("; ");
}

export function clearCookieHeader(name: string, path = "/"): string {
  return `${name}=; Path=${path}; Max-Age=0; SameSite=Lax; Secure; HttpOnly`;
}

// ── Provider helpers ────────────────────────────────────────────────────────

export function lwBase(env: AuthEnv): string {
  return env.LW_OAUTH_BASE_URL || DEFAULT_LW_BASE;
}

export function callbackUrl(request: Request): string {
  const u = new URL(request.url);
  // Always advertise the canonical deployment origin so /api/auth/callback
  // matches what we registered on the provider. The provider validates the
  // exact string in its redirect_uris[] list.
  return `${u.origin}/api/auth/callback`;
}

// ── Constants ───────────────────────────────────────────────────────────────

export const PKCE_COOKIE = "vtt_pkce";
export const SESSION_COOKIE = "vtt_session";
// PKCE flow has 5 minutes to complete (matches the upstream pending TTL)
export const PKCE_TTL = 5 * 60;
// Session lives 30 days
export const SESSION_TTL = 30 * 24 * 60 * 60;
