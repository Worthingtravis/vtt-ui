/**
 * GET /api/auth/me — returns the current user's identity from the
 * vtt_session cookie.
 *
 * If the upstream userinfo endpoint wasn't deployed when the session was
 * minted (userinfo_missing flag), retry it now using the stored access
 * token. This makes the UI light up automatically the moment laughingwhales.com
 * ships /api/oauth/userinfo without any cookie wipe / re-login.
 */
import {
  AuthEnv,
  SESSION_COOKIE,
  SESSION_TTL,
  lwBase,
  packSigned,
  readCookie,
  setCookieHeader,
  unpackSigned,
} from "./_lib";

interface SessionPayload {
  sub: string;
  login: string | null;
  name: string | null;
  picture: string | null;
  userinfo_missing: boolean;
  at: string;
  rt: string;
  at_exp: number;
  exp: number;
}

interface UserInfo {
  sub: string;
  login?: string | null;
  preferred_username?: string | null;
  name?: string | null;
  picture?: string | null;
}

const NO_AUTH = { authenticated: false } as const;

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      ...(init.headers || {}),
    },
  });
}

export const onRequestGet: PagesFunction<AuthEnv> = async ({ request, env }) => {
  if (!env.LW_COOKIE_SECRET) {
    return json(NO_AUTH, { status: 200 });
  }

  const session = await unpackSigned<SessionPayload>(
    env.LW_COOKIE_SECRET,
    readCookie(request, SESSION_COOKIE),
  );
  if (!session) return json(NO_AUTH, { status: 200 });

  // Try to upgrade an anonymous session by hitting userinfo lazily.
  let upgraded: SessionPayload | null = null;
  if (session.userinfo_missing && session.at) {
    try {
      const r = await fetch(`${lwBase(env)}/api/oauth/userinfo`, {
        headers: { authorization: `Bearer ${session.at}` },
      });
      if (r.ok) {
        const u = (await r.json()) as UserInfo;
        upgraded = {
          ...session,
          sub: u.sub,
          login: u.login || u.preferred_username || null,
          name: u.name || null,
          picture: u.picture || null,
          userinfo_missing: false,
        };
      }
    } catch {
      // ignore — keep current session
    }
  }

  const view = upgraded ?? session;
  const headers = new Headers({ "content-type": "application/json", "cache-control": "no-store" });
  if (upgraded) {
    const cookie = await packSigned(
      env.LW_COOKIE_SECRET,
      {
        sub: upgraded.sub,
        login: upgraded.login,
        name: upgraded.name,
        picture: upgraded.picture,
        userinfo_missing: false,
        at: upgraded.at,
        rt: upgraded.rt,
        at_exp: upgraded.at_exp,
      },
      SESSION_TTL,
    );
    headers.append(
      "Set-Cookie",
      setCookieHeader({
        name: SESSION_COOKIE,
        value: cookie,
        maxAgeSeconds: SESSION_TTL,
      }),
    );
  }

  return new Response(
    JSON.stringify({
      authenticated: true,
      sub: view.sub,
      login: view.login,
      display_name: view.name,
      picture: view.picture,
      userinfo_missing: view.userinfo_missing,
      exp: view.exp,
    }),
    { status: 200, headers },
  );
};
