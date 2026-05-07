/**
 * POST /api/scan/download_and_queue
 *
 * Auth-gated proxy that queues a vod_scan_chain job on the local serve.py
 * backend. Called when /api/scan/queue returns a 409 vod_audio_missing for
 * a VOD whose meta sidecar has a recoverable stream_id.
 *
 * The backend (/api/vodvod/download_then_scan) will:
 *   1. Queue a vodvod download job
 *   2. Wait for it to complete
 *   3. Queue and wait for an xcorr_scan job
 * The returned job_id covers the full lifecycle.
 *
 * Request:  {creator, basename}
 * Response: {ok, job_id, kind, deduped?}   (200)
 *           {ok: false, error}              (400/401/502)
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

interface ChainPayload {
  creator?: string;
  basename?: string;
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
    return json({ ok: false, error: "log in to queue downloads" }, 401);
  }

  let body: ChainPayload;
  try {
    body = (await request.json()) as ChainPayload;
  } catch {
    return json({ ok: false, error: "invalid json body" }, 400);
  }
  const creator = String(body.creator || "").trim();
  const basename = String(body.basename || "").trim().replace(/\.(mp4|mkv|webm|ts|json)$/i, "");
  if (!creator || !basename) {
    return json({ ok: false, error: "creator and basename required" }, 400);
  }
  if (!/^[\w.-]+$/.test(creator)) {
    return json({ ok: false, error: "invalid creator" }, 400);
  }

  const renderApi = await getRenderApi();
  if (!renderApi) {
    return json({ ok: false, error: "render api unavailable" }, 502);
  }

  const upstream = await fetch(`${renderApi}/api/vodvod/download_then_scan`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-vtt-user-sub": session.sub,
      "x-vtt-user-login": session.login || "",
    },
    body: JSON.stringify({ creator, basename }),
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
