/**
 * GET /api/auth/callback — finishes the OAuth flow.
 *
 * Steps:
 * 1. Verify the signed PKCE cookie + state echo from the upstream.
 * 2. POST to /api/oauth/token with the code + verifier.
 * 3. Try /api/oauth/userinfo to fill identity (login, displayName).
 *    The upstream may not have userinfo wired up yet; if it 404s we still
 *    issue a session keyed by the access token + provider sub claim from
 *    the validation ping.
 * 4. Mint a signed session cookie and 302 back to the original returnTo.
 */
import {
  AuthEnv,
  PKCE_COOKIE,
  SESSION_COOKIE,
  SESSION_TTL,
  callbackUrl,
  clearCookieHeader,
  lwBase,
  packSigned,
  setCookieHeader,
  unpackSigned,
  readCookie,
} from "./_lib";

interface PkcePayload {
  state: string;
  verifier: string;
  returnTo: string;
}
interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type?: string;
}
interface UserInfo {
  sub: string;
  login?: string | null;
  preferred_username?: string | null;
  name?: string | null;
  picture?: string | null;
}

function html(status: number, body: string): Response {
  return new Response(
    `<!doctype html><meta charset="utf-8"><title>auth</title>` +
      `<style>body{font:14px/1.5 ui-sans-serif,system-ui,sans-serif;background:#0b1020;color:#e5e7eb;` +
      `padding:48px;max-width:560px;margin:0 auto}h1{color:#fca5a5;font-size:18px}code{color:#fde047}` +
      `a{color:#7dd3fc}</style>${body}`,
    { status, headers: { "content-type": "text/html; charset=utf-8" } },
  );
}

export const onRequestGet: PagesFunction<AuthEnv> = async ({ request, env }) => {
  if (!env.LW_OAUTH_CLIENT_ID || !env.LW_COOKIE_SECRET) {
    return html(500, `<h1>auth misconfigured</h1><p>LW_OAUTH_CLIENT_ID and LW_COOKIE_SECRET must be set</p>`);
  }

  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const errorParam = url.searchParams.get("error");
  if (errorParam) {
    const desc = url.searchParams.get("error_description") || errorParam;
    return html(400, `<h1>upstream denied auth</h1><p><code>${escape(desc)}</code></p><p><a href="/">back</a></p>`);
  }
  if (!code || !state) {
    return html(400, `<h1>missing code/state</h1><p><a href="/">back</a></p>`);
  }

  const pkce = await unpackSigned<PkcePayload>(
    env.LW_COOKIE_SECRET,
    readCookie(request, PKCE_COOKIE),
  );
  if (!pkce) {
    return html(400, `<h1>auth state expired</h1><p>start over from <a href="/">/</a></p>`);
  }
  if (pkce.state !== state) {
    return html(400, `<h1>state mismatch</h1><p>possible CSRF — restart from <a href="/">/</a></p>`);
  }

  // ── Exchange code for tokens ──────────────────────────────────────────────
  const redirectUri = callbackUrl(request);
  const tokenBody = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: env.LW_OAUTH_CLIENT_ID,
    code_verifier: pkce.verifier,
  });
  let tokenResp: TokenResponse;
  try {
    const r = await fetch(`${lwBase(env)}/api/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: tokenBody.toString(),
    });
    if (!r.ok) {
      const txt = await r.text().catch(() => "");
      return html(
        400,
        `<h1>token exchange failed</h1><p>upstream returned ${r.status}: <code>${escape(txt.slice(0, 300))}</code></p>`,
      );
    }
    tokenResp = (await r.json()) as TokenResponse;
  } catch (err) {
    return html(502, `<h1>upstream unreachable</h1><p><code>${escape(String(err))}</code></p>`);
  }

  // ── Fetch identity (best-effort) ──────────────────────────────────────────
  // The upstream userinfo endpoint may not be deployed yet; treat 404 as
  // "anonymous-but-authenticated" and key the session off the access token's
  // hash so we still have a stable identifier.
  let userinfo: UserInfo | null = null;
  try {
    const r = await fetch(`${lwBase(env)}/api/oauth/userinfo`, {
      headers: { authorization: `Bearer ${tokenResp.access_token}` },
    });
    if (r.ok) userinfo = (await r.json()) as UserInfo;
  } catch {
    // best-effort; fall through to anon session
  }

  const identity = userinfo
    ? {
        sub: userinfo.sub,
        login: userinfo.login || userinfo.preferred_username || null,
        name: userinfo.name || null,
        picture: userinfo.picture || null,
      }
    : {
        sub: await tokenHash(tokenResp.access_token),
        login: null,
        name: null,
        picture: null,
        userinfo_missing: true,
      };

  // Session cookie: keep small. We persist the access_token+refresh_token so
  // future identity/refresh calls upstream are possible without re-prompting.
  const sessionPayload = {
    sub: identity.sub,
    login: identity.login,
    name: identity.name,
    picture: identity.picture,
    userinfo_missing: identity.userinfo_missing ?? false,
    at: tokenResp.access_token,
    rt: tokenResp.refresh_token,
    at_exp: Math.floor(Date.now() / 1000) + (tokenResp.expires_in || 0),
  };

  const sessionCookie = await packSigned(env.LW_COOKIE_SECRET, sessionPayload, SESSION_TTL);

  const headers = new Headers();
  headers.set("Location", pkce.returnTo || "/");
  headers.append(
    "Set-Cookie",
    setCookieHeader({
      name: SESSION_COOKIE,
      value: sessionCookie,
      maxAgeSeconds: SESSION_TTL,
    }),
  );
  // Clear PKCE cookie now that the flow is done
  headers.append("Set-Cookie", clearCookieHeader(PKCE_COOKIE));
  headers.set("Cache-Control", "no-store");
  return new Response(null, { status: 302, headers });
};

async function tokenHash(token: string): Promise<string> {
  const enc = new TextEncoder();
  const digest = await crypto.subtle.digest("SHA-256", enc.encode(token));
  const u8 = new Uint8Array(digest);
  let s = "anon_";
  // 12 hex chars are plenty as a stable opaque sub.
  for (let i = 0; i < 6; i++) s += u8[i].toString(16).padStart(2, "0");
  return s;
}

function escape(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string),
  );
}
