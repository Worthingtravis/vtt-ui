/**
 * POST /api/event_label/append
 *
 * Auth-gated proxy for the per-event 👍/👎 feedback buttons. Reads the
 * vtt_session cookie (HMAC-signed via LW_COOKIE_SECRET), 401s anonymous
 * users, and forwards the body to the local serve.py over the cloudflared
 * tunnel — adding X-VTT-User-Sub / X-VTT-User-Login headers so each label
 * row in the manifest is attributable to a specific Twitch identity.
 *
 * Why this exists as a Pages Function rather than letting the UI hit the
 * tunnel directly: the cookie secret + signed payload only round-trips
 * cleanly through Workers code; the static SPA can't verify a session.
 */
import {
  AuthEnv,
  SESSION_COOKIE,
  readCookie,
  unpackSigned,
} from "../auth/_lib";

interface SessionPayload {
  sub: string;
  login: string | null;
  name: string | null;
  picture: string | null;
  userinfo_missing?: boolean;
  at?: string;
  rt?: string;
  at_exp?: number;
  exp: number;
}

const PUBLIC_R2 = "https://pub-868d2bf7e2f6434c860d65dfe1cadad4.r2.dev";

function json(body: unknown, status = 200, extra: HeadersInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...extra },
  });
}

// The cloudflared tunnel URL rotates on restart; the canonical pointer lives
// in R2 alongside the public indexes. Cache it on the edge for 60s so the
// vote round-trip stays sub-100ms once warm.
async function getRenderApi(): Promise<string | null> {
  try {
    const r = await fetch(`${PUBLIC_R2}/config.json`, { cf: { cacheTtl: 60 } } as RequestInit);
    if (!r.ok) return null;
    const d = (await r.json()) as { render_api_base?: string };
    return d.render_api_base || null;
  } catch {
    return null;
  }
}

interface VotePayload {
  creator?: string;
  basename?: string;
  event?: string;
  t_sec?: number;
  label?: 0 | 1;
  score?: number | null;
}

export const onRequestPost: PagesFunction<AuthEnv> = async ({ request, env }) => {
  if (!env.LW_COOKIE_SECRET) {
    return json({ ok: false, error: "auth not configured" }, 500);
  }
  const session = await unpackSigned<SessionPayload>(
    env.LW_COOKIE_SECRET,
    readCookie(request, SESSION_COOKIE),
  );
  if (!session || !session.sub) {
    return json({ ok: false, error: "log in to vote" }, 401);
  }

  let body: VotePayload;
  try {
    body = (await request.json()) as VotePayload;
  } catch {
    return json({ ok: false, error: "invalid json body" }, 400);
  }
  const creator = String(body.creator || "").trim();
  const basename = String(body.basename || "").trim();
  const event = String(body.event || "").trim();
  const t_sec = Number(body.t_sec);
  const label = Number(body.label);
  if (!creator || !basename || !event || !Number.isFinite(t_sec) || (label !== 0 && label !== 1)) {
    return json({ ok: false, error: "creator, basename, event, t_sec, label required" }, 400);
  }

  const renderApi = await getRenderApi();
  if (!renderApi) {
    return json({ ok: false, error: "render api unavailable" }, 502);
  }

  const upstream = await fetch(`${renderApi}/api/event_label/append`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-vtt-user-sub": session.sub,
      "x-vtt-user-login": session.login || "",
    },
    body: JSON.stringify({
      creator, basename, event,
      t_sec, label,
      score: body.score == null ? null : Number(body.score),
    }),
  });

  const text = await upstream.text();
  return new Response(text, {
    status: upstream.status,
    headers: {
      "content-type": upstream.headers.get("content-type") || "application/json",
      "cache-control": "no-store",
    },
  });
};
