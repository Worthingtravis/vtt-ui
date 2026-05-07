/**
 * POST /api/auth/logout — clears the vtt_session cookie.
 * 204 on success.
 *
 * Note: we don't revoke the upstream tokens here. The upstream session
 * lives on Twitch+laughingwhales.com side; logging out just nukes our
 * local cookie so this browser stops being authenticated to vtt-ui.
 */
import { AuthEnv, SESSION_COOKIE, clearCookieHeader } from "./_lib";

export const onRequestPost: PagesFunction<AuthEnv> = async () => {
  const headers = new Headers();
  headers.append("Set-Cookie", clearCookieHeader(SESSION_COOKIE));
  headers.set("Cache-Control", "no-store");
  return new Response(null, { status: 204, headers });
};

// Some browsers / curl flows hit this with GET; accept both for ergonomics.
export const onRequestGet = onRequestPost;
