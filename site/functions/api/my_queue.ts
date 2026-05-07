/**
 * GET /api/my_queue
 *
 * Returns the last 20 jobs submitted by the authenticated user, newest first.
 * Auth-gated: reads the vtt_session cookie (HMAC-signed via LW_COOKIE_SECRET),
 * 401s anonymous callers. Forwards the user's OAuth sub to the local serve.py
 * /api/my_queue?submitter=<sub> endpoint over the cloudflared tunnel.
 *
 * Response shape (200):
 *   {
 *     ok: true,
 *     jobs: [{
 *       job_id, kind, creator, basename, status, restart_orphan,
 *       queued_at, started_at, finished_at, deep_link, error, progress,
 *       submitter_login
 *     }, ...]
 *   }
 *
 * Status values: queued | running | done | failed | cancelled | orphaned
 * "orphaned" means the job was running when serve.py restarted — the user
 * should re-trigger the submission.
 */
import {
  AuthEnv,
  SESSION_COOKIE,
  readCookie,
  unpackSigned,
} from "./auth/_lib";

interface SessionPayload {
  sub: string;
  login: string | null;
  name: string | null;
  picture: string | null;
  exp: number;
}

const PUBLIC_R2 = "https://pub-868d2bf7e2f6434c860d65dfe1cadad4.r2.dev";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

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

export const onRequestGet: PagesFunction<AuthEnv> = async ({ request, env }) => {
  if (!env.LW_COOKIE_SECRET) {
    return json({ ok: false, error: "auth not configured" }, 500);
  }
  const session = await unpackSigned<SessionPayload>(
    env.LW_COOKIE_SECRET,
    readCookie(request, SESSION_COOKIE),
  );
  if (!session || !session.sub) {
    return json({ ok: false, error: "authentication required" }, 401);
  }

  const renderApi = await getRenderApi();
  if (!renderApi) {
    return json({ ok: false, error: "render api unavailable" }, 502);
  }

  const upstream = await fetch(
    `${renderApi}/api/my_queue?submitter=${encodeURIComponent(session.sub)}`,
    {
      method: "GET",
      headers: {
        "x-vtt-user-sub": session.sub,
        "x-vtt-user-login": session.login || "",
      },
    },
  );

  const text = await upstream.text();
  return new Response(text, {
    status: upstream.status,
    headers: {
      "content-type": upstream.headers.get("content-type") || "application/json",
      "cache-control": "no-store",
    },
  });
};
