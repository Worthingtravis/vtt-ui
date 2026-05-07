/**
 * GET /api/auth/login — kicks off the OAuth flow against laughingwhales.com.
 *
 * 1. Generate PKCE verifier + challenge (S256) and a state nonce.
 * 2. Park (verifier, state, returnTo) in a short-lived signed cookie so the
 *    callback can verify it without any server-side store.
 * 3. 302 the browser to the upstream /api/oauth/authorize.
 *
 * Optional `?returnTo=/path` is preserved across the round-trip so we can
 * land the user back where they tried to log in from.
 */
import {
  AuthEnv,
  PKCE_COOKIE,
  PKCE_TTL,
  callbackUrl,
  lwBase,
  packSigned,
  pkceChallenge,
  randomToken,
  setCookieHeader,
} from "./_lib";

function isSafePath(p: string | null): p is string {
  return !!p && p.startsWith("/") && !p.startsWith("//");
}

export const onRequestGet: PagesFunction<AuthEnv> = async ({ request, env }) => {
  if (!env.LW_OAUTH_CLIENT_ID || !env.LW_COOKIE_SECRET) {
    return new Response(
      "Auth misconfigured: LW_OAUTH_CLIENT_ID and LW_COOKIE_SECRET must be set",
      { status: 500 },
    );
  }

  const url = new URL(request.url);
  const returnTo = isSafePath(url.searchParams.get("returnTo"))
    ? url.searchParams.get("returnTo")!
    : "/";

  const verifier = randomToken(48); // ~64 chars b64url, well within PKCE 43–128 spec
  const challenge = await pkceChallenge(verifier);
  const state = randomToken(32);

  const pkceCookie = await packSigned(
    env.LW_COOKIE_SECRET,
    { state, verifier, returnTo },
    PKCE_TTL,
  );

  const redirectUri = callbackUrl(request);
  const params = new URLSearchParams({
    client_id: env.LW_OAUTH_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: "code",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    // Identity-only — vtt-ui only needs the user's Twitch login. Twitch
    // shows a zero-scope consent screen for empty `scope`, so this avoids
    // inheriting the streamer-mcp broadcaster scope set from the upstream
    // /api/oauth/authorize default. Keep this field present-but-empty
    // (don't omit it) so the upstream sees an explicit "no scopes" request.
    scope: "",
  });

  const headers = new Headers();
  headers.set("Location", `${lwBase(env)}/api/oauth/authorize?${params.toString()}`);
  headers.append(
    "Set-Cookie",
    setCookieHeader({
      name: PKCE_COOKIE,
      value: pkceCookie,
      maxAgeSeconds: PKCE_TTL,
    }),
  );
  headers.set("Cache-Control", "no-store");
  return new Response(null, { status: 302, headers });
};
